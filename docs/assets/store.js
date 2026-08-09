import { FIREBASE_SETTINGS } from "./firebase-config.js";

const LOCAL_MEMBERS_KEY = "tennis-match:members:v1";
const LOCAL_SESSIONS_KEY = "tennis-match:sessions:v1";
const LOCAL_REVISIONS_KEY = "tennis-match:revisions:v1";

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readLocal(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : clone(fallback);
  } catch {
    return clone(fallback);
  }
}

function writeLocal(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

class LocalStore {
  constructor(seedData) {
    this.mode = "local";
    this.requiresAuth = false;
    this.seedData = seedData;
    this.memberListeners = new Set();
    this.sessionListeners = new Set();
  }

  onAuthStateChanged(callback) {
    queueMicrotask(() => callback({ uid: "local-operator", email: "로컬 데모" }));
    return () => {};
  }

  async signInWithGoogle() {
    return { uid: "local-operator", email: "로컬 데모" };
  }

  async signOut() {}

  currentMembers() {
    return readLocal(LOCAL_MEMBERS_KEY, this.seedData.members);
  }

  currentSessions() {
    return readLocal(LOCAL_SESSIONS_KEY, this.seedData.sessions);
  }

  start({ onMembers, onSessions }) {
    this.memberListeners.add(onMembers);
    this.sessionListeners.add(onSessions);
    onMembers(this.currentMembers());
    onSessions(this.currentSessions().sort((a, b) => b.date.localeCompare(a.date)));
    const storageListener = (event) => {
      if (event.key === LOCAL_MEMBERS_KEY) onMembers(this.currentMembers());
      if (event.key === LOCAL_SESSIONS_KEY) onSessions(this.currentSessions());
    };
    window.addEventListener("storage", storageListener);
    return () => {
      this.memberListeners.delete(onMembers);
      this.sessionListeners.delete(onSessions);
      window.removeEventListener("storage", storageListener);
    };
  }

  notifyMembers() {
    const members = this.currentMembers();
    this.memberListeners.forEach((listener) => listener(members));
  }

  notifySessions() {
    const sessions = this.currentSessions().sort((a, b) => b.date.localeCompare(a.date));
    this.sessionListeners.forEach((listener) => listener(sessions));
  }

  async saveMember(member) {
    const members = this.currentMembers();
    const index = members.findIndex((item) => item.id === member.id);
    if (index >= 0) members[index] = clone(member);
    else members.push(clone(member));
    writeLocal(LOCAL_MEMBERS_KEY, members);
    this.notifyMembers();
    return member;
  }

  async saveSession(session, expectedRevision = 0) {
    const sessions = this.currentSessions();
    const existingIndex = sessions.findIndex((item) => item.date === session.date);
    const existing = existingIndex >= 0 ? sessions[existingIndex] : null;
    const currentRevision = existing?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new ConflictError("다른 운영자가 이 날짜의 대진을 먼저 변경했습니다.");
    }
    const revisions = readLocal(LOCAL_REVISIONS_KEY, {});
    if (existing) {
      revisions[session.date] ??= [];
      revisions[session.date].push(existing);
      writeLocal(LOCAL_REVISIONS_KEY, revisions);
    }
    const saved = {
      ...clone(session),
      revision: currentRevision + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: "로컬 데모",
    };
    if (existingIndex >= 0) sessions[existingIndex] = saved;
    else sessions.push(saved);
    writeLocal(LOCAL_SESSIONS_KEY, sessions);
    this.notifySessions();
    return saved;
  }

  async exportBackup() {
    return {
      exportedAt: new Date().toISOString(),
      members: this.currentMembers(),
      sessions: this.currentSessions(),
      revisions: readLocal(LOCAL_REVISIONS_KEY, {}),
    };
  }
}

async function loadFirebaseModules() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_SETTINGS.sdkVersion}`;
  const [app, auth, firestore] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`),
  ]);
  return { app, auth, firestore };
}

class FirebaseStore {
  constructor(seedData, modules) {
    this.mode = "cloud";
    this.requiresAuth = true;
    this.seedData = seedData;
    this.modules = modules;
    this.app = modules.app.initializeApp(FIREBASE_SETTINGS.project);
    this.auth = modules.auth.getAuth(this.app);
    this.db = modules.firestore.getFirestore(this.app);
    this.user = null;
  }

  onAuthStateChanged(callback) {
    return this.modules.auth.onAuthStateChanged(this.auth, (user) => {
      this.user = user;
      callback(user);
    });
  }

  async signInWithGoogle() {
    const provider = new this.modules.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const result = await this.modules.auth.signInWithPopup(this.auth, provider);
    return result.user;
  }

  async signOut() {
    await this.modules.auth.signOut(this.auth);
  }

  async seedIfEmpty() {
    const fs = this.modules.firestore;
    const membersRef = fs.collection(this.db, "members");
    const existingMembers = await fs.getDocs(fs.limit(fs.query(membersRef), 1));
    if (!existingMembers.empty) return;
    const batch = fs.writeBatch(this.db);
    this.seedData.members.forEach((member) => {
      batch.set(fs.doc(this.db, "members", member.id), { ...member, seeded: true });
    });
    this.seedData.sessions.forEach((session) => {
      batch.set(fs.doc(this.db, "sessions", session.date), {
        ...session,
        revision: 1,
        status: "imported",
        rulesVersion: this.seedData.rulesVersion,
        seeded: true,
      });
    });
    await batch.commit();
  }

  async start({ onMembers, onSessions, onError }) {
    if (!this.user) throw new Error("운영자 로그인이 필요합니다.");
    await this.seedIfEmpty();
    const fs = this.modules.firestore;
    const memberQuery = fs.query(fs.collection(this.db, "members"), fs.orderBy("name"));
    const sessionQuery = fs.query(fs.collection(this.db, "sessions"), fs.orderBy("date", "desc"));
    const unsubscribeMembers = fs.onSnapshot(
      memberQuery,
      (snapshot) => onMembers(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
      onError,
    );
    const unsubscribeSessions = fs.onSnapshot(
      sessionQuery,
      (snapshot) => onSessions(snapshot.docs.map((item) => ({ date: item.id, ...item.data() }))),
      onError,
    );
    return () => {
      unsubscribeMembers();
      unsubscribeSessions();
    };
  }

  async saveMember(member) {
    if (!this.user) throw new Error("운영자 로그인이 필요합니다.");
    const fs = this.modules.firestore;
    const payload = clone({
      ...member,
      updatedBy: this.user.email,
    });
    delete payload.id;
    await fs.setDoc(fs.doc(this.db, "members", member.id), {
      ...payload,
      updatedAt: fs.serverTimestamp(),
    });
    return member;
  }

  async saveSession(session, expectedRevision = 0) {
    if (!this.user) throw new Error("운영자 로그인이 필요합니다.");
    const fs = this.modules.firestore;
    const sessionRef = fs.doc(this.db, "sessions", session.date);
    return fs.runTransaction(this.db, async (transaction) => {
      const snapshot = await transaction.get(sessionRef);
      const existing = snapshot.exists() ? snapshot.data() : null;
      const currentRevision = existing?.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        throw new ConflictError("다른 운영자가 이 날짜의 대진을 먼저 변경했습니다.");
      }
      if (existing) {
        const revisionRef = fs.doc(
          this.db,
          "sessions",
          session.date,
          "revisions",
          String(currentRevision).padStart(4, "0"),
        );
        transaction.set(revisionRef, {
          ...clone(existing),
          archivedAt: fs.serverTimestamp(),
        });
      }
      const saved = clone({
        ...session,
        revision: currentRevision + 1,
        updatedBy: this.user.email,
      });
      transaction.set(sessionRef, { ...saved, updatedAt: fs.serverTimestamp() });
      return saved;
    });
  }

  async exportBackup() {
    const fs = this.modules.firestore;
    const [members, sessions] = await Promise.all([
      fs.getDocs(fs.collection(this.db, "members")),
      fs.getDocs(fs.collection(this.db, "sessions")),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      members: members.docs.map((item) => ({ id: item.id, ...item.data() })),
      sessions: sessions.docs.map((item) => ({ date: item.id, ...item.data() })),
    };
  }
}

export async function createStore(seedData) {
  const configured =
    FIREBASE_SETTINGS.enabled &&
    FIREBASE_SETTINGS.project.apiKey &&
    FIREBASE_SETTINGS.project.projectId;
  if (!configured) return new LocalStore(seedData);
  return new FirebaseStore(seedData, await loadFirebaseModules());
}
