import {
  RULES,
  SLOT_LABELS,
  evaluateSchedule,
  formatScore,
  scheduleToText,
  swapPlayers,
} from "./matchup-core.js";
import { ConflictError, createStore } from "./store.js?v=20260811-1";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const BREAKDOWN_LABELS = Object.freeze({
  balance: "코트 내 팀 실력 균형",
  balanceHeavy: "일방적인 코트 추가 벌점",
  duplicatePartner: "같은 날 파트너 중복",
  opponentAllThree: "3타임 내내 같은 상대",
  gender: "성별 조합 어긋남",
  historyPartner: "최근 파트너 재조합",
  historyOpponent: "최근 상대 재대결",
  duplicateOpponent: "같은 날 상대 중복",
  spread: "코트 내 실력 편차",
});

const VIEW_LABELS = Object.freeze({
  participants: "참석자 선택",
  results: "대진표",
  history: "확정 기록",
  guide: "이용 안내",
});

const state = {
  seedData: null,
  store: null,
  stopSync: null,
  user: null,
  members: [],
  sessions: [],
  selectedIds: [],
  guests: [],
  filter: "all",
  search: "",
  manageMembers: false,
  currentView: "participants",
  candidates: [],
  activeCandidate: 0,
  generatedPlayers: [],
  seed: null,
  tapSource: null,
  drag: null,
  suppressClick: false,
};

const worker = new Worker("./assets/matchup-worker.js", { type: "module" });
let pendingGeneration = null;
let toastTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clone(value) {
  return structuredClone(value);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function setLoading(open, progress = 4, text = "315개 타임 조합을 비교하고 있습니다.") {
  $("#loadingOverlay").classList.toggle("hidden", !open);
  $("#progressBar").style.width = `${Math.max(4, progress)}%`;
  $("#loadingText").textContent = text;
}

function dateToInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nextAvailableSunday(sessions) {
  const used = new Set(sessions.map((session) => session.date));
  const next = new Date();
  next.setHours(12, 0, 0, 0);
  next.setDate(next.getDate() + ((7 - next.getDay()) % 7));
  while (used.has(dateToInput(next))) next.setDate(next.getDate() + 7);
  return dateToInput(next);
}

function formatDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  const weekday = weekdays[new Date(year, month - 1, day, 12).getDay()];
  return `${year}.${month}.${day}(${weekday})`;
}

function selectedPlayers() {
  const members = state.selectedIds
    .map((id) => state.members.find((member) => member.id === id))
    .filter(Boolean);
  return [...members, ...state.guests];
}

function activeSessions() {
  return state.sessions.filter((session) => session.status !== "archived");
}

function setView(view) {
  state.currentView = view;
  $$('[data-view-panel]').forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  $$('[data-view]').forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $("#mobileSectionLabel").textContent = VIEW_LABELS[view];
  if (view === "results") renderResults();
  if (view === "history") renderHistory();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateModeUi() {
  const cloud = state.store?.mode === "cloud";
  for (const badge of [$("#sideModeBadge"), $("#mobileModeBadge")]) {
    badge.textContent = cloud ? "공유 연결" : badge.id === "mobileModeBadge" ? "로컬" : "로컬 데모";
    badge.classList.toggle("local", !cloud);
  }
  $("#operatorLabel").textContent = cloud
    ? state.user?.email ?? "로그인 필요"
    : "이 기기에만 저장됩니다";
  $("#signOutButton").classList.toggle("hidden", !cloud || !state.user);
}

function renderSelectionSummary(players) {
  const container = $("#selectionSummary");
  if (players.length !== 8) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  const genders = ["남", "여"];
  const levelGroups = ["A", "B", "C"];
  const rows = genders
    .map(
      (gender) => `
        <tr>
          <th scope="row">${gender}</th>
          ${levelGroups
            .map((level) => {
              const matches = players.filter(
                (player) => player.gender === gender && String(player.level).toUpperCase().startsWith(level),
              );
              return `
                <td>
                  <strong>${matches.length}명</strong>
                  <span>${matches.length ? matches.map((player) => escapeHtml(player.name)).join(" · ") : "-"}</span>
                </td>`;
            })
            .join("")}
        </tr>`,
    )
    .join("");
  container.innerHTML = `
    <div class="selection-summary-heading">
      <strong>선택 요약</strong><span>성별 × 실력 등급</span>
    </div>
    <div class="selection-summary-scroll">
      <table>
        <thead><tr><th scope="col">성별</th>${levelGroups.map((level) => `<th scope="col">${level}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  container.classList.remove("hidden");
}

function renderSelected() {
  const players = selectedPlayers();
  $("#selectedCount").textContent = String(players.length);
  $("#generateButton").disabled = players.length !== 8;
  const participantHero = $("#participantsView .participant-hero");
  participantHero.classList.toggle("has-selection", players.length > 0);
  participantHero.classList.toggle("selection-complete", players.length === 8);
  renderSelectionSummary(players);
}

function renderMembers() {
  const selected = new Set(state.selectedIds);
  const query = state.search.trim().toLocaleLowerCase("ko");
  const members = state.members
    .filter((member) => {
      if (!state.manageMembers && member.active === false) return false;
      if (state.filter === "inactive" && member.active !== false) return false;
      if (state.filter === "selected" && !selected.has(member.id)) return false;
      if (["남", "여"].includes(state.filter) && member.gender !== state.filter) return false;
      if (!query) return true;
      return `${member.name} ${member.level}`.toLocaleLowerCase("ko").includes(query);
    });

  $("#memberGrid").innerHTML = members.length
    ? members
        .map(
          (member) => {
            const content = `
              <strong>${escapeHtml(member.name)}</strong>
              <span class="member-meta">
                <span class="gender-badge">${escapeHtml(member.gender)}</span>
                <span class="level-badge">${escapeHtml(member.level)}</span>
              </span>`;
            if (state.manageMembers) {
              return `
                <div class="member-manage-item ${member.active === false ? "inactive" : ""}">
                  <div class="member-button">${content}</div>
                  <button class="member-status-button" data-member-status="${escapeHtml(member.id)}" type="button">
                    ${member.active === false ? "다시 활성화" : "비활성화"}
                  </button>
                </div>`;
            }
            return `
              <button
                type="button"
                class="member-button ${selected.has(member.id) ? "selected" : ""}"
                data-member-id="${escapeHtml(member.id)}"
                aria-pressed="${selected.has(member.id)}"
              >${content}</button>`;
          },
        )
        .join("")
    : '<div class="member-empty">조건에 맞는 회원이 없습니다.</div>';
  $("#manageMembersButton").textContent = state.manageMembers ? "선택 모드" : "회원 관리";
  $("#inactiveFilter").classList.toggle("hidden", !state.manageMembers);
  renderSelected();
}

async function toggleMemberStatus(id) {
  const member = state.members.find((item) => item.id === id);
  if (!member) return;
  const active = member.active === false;
  const updated = { ...member, active };
  if (!active) state.selectedIds = state.selectedIds.filter((memberId) => memberId !== id);
  try {
    await state.store.saveMember(updated);
    state.members = state.members.map((item) => (item.id === id ? updated : item));
    renderMembers();
    showToast(active ? `${member.name} 회원을 다시 활성화했습니다.` : `${member.name} 회원을 비활성화했습니다.`);
  } catch (error) {
    showToast(error.message);
  }
}

function openParticipantDialog(saveAsMember) {
  $("#guestForm").reset();
  populateLevels();
  $("#saveAsMember").checked = saveAsMember;
  $("#participantDialogEyebrow").textContent = saveAsMember ? "신규 회원" : "일회성 게스트";
  $("#participantDialogTitle").textContent = saveAsMember ? "공유 회원 명단에 추가하세요" : "이번 참석자 정보를 입력하세요";
  $("#participantSubmitButton").textContent = saveAsMember ? "회원으로 저장하고 선택" : "게스트로 추가";
  $("#guestDialog").showModal();
}

function toggleMember(id) {
  const index = state.selectedIds.indexOf(id);
  if (index >= 0) state.selectedIds.splice(index, 1);
  else if (selectedPlayers().length >= 8) return showToast("참석자는 8명까지만 선택할 수 있습니다.");
  else state.selectedIds.push(id);
  renderMembers();
}

function selectMembersByName(event) {
  event.preventDefault();
  const input = $("#bulkSelectInput");
  const feedback = $("#bulkSelectFeedback");
  const names = [...new Set(input.value.trim().split(/\s+/).filter(Boolean))];
  if (!names.length) {
    feedback.textContent = "선택할 이름을 띄어쓰기로 입력해주세요.";
    input.focus();
    return;
  }

  const activeMembers = state.members.filter((member) => member.active !== false);
  const added = [];
  const alreadySelected = [];
  const missing = [];
  const skipped = [];
  names.forEach((name) => {
    const member = activeMembers.find((item) => item.name === name);
    if (!member) {
      missing.push(name);
      return;
    }
    if (state.selectedIds.includes(member.id)) {
      alreadySelected.push(name);
      return;
    }
    if (selectedPlayers().length >= 8) {
      skipped.push(name);
      return;
    }
    state.selectedIds.push(member.id);
    added.push(name);
  });
  renderMembers();

  const messages = [];
  if (added.length) messages.push(`${added.length}명을 선택했습니다.`);
  if (alreadySelected.length) messages.push(`이미 선택됨: ${alreadySelected.join(", ")}`);
  if (missing.length) messages.push(`명단에서 찾지 못함: ${missing.join(", ")}`);
  if (skipped.length) messages.push(`8명 제한으로 제외: ${skipped.join(", ")}`);
  feedback.textContent = messages.join(" ") || "선택 상태가 바뀌지 않았습니다.";
  if (added.length) showToast(`${selectedPlayers().length}명의 참석자가 선택되었습니다.`);
}

function populateLevels() {
  const levels = Object.entries(state.seedData.levels);
  $("#guestLevel").innerHTML = levels
    .map(([level, score]) => `<option value="${escapeHtml(level)}">${escapeHtml(level)} · ${formatScore(score)}점</option>`)
    .join("");
}

function runGeneration(payload) {
  return new Promise((resolve, reject) => {
    pendingGeneration = { resolve, reject };
    worker.postMessage({ type: "generate", payload });
  });
}

worker.addEventListener("message", ({ data }) => {
  if (data.type === "progress") {
    setLoading(true, data.progress, `우수 후보를 비교하고 있습니다 · ${data.progress}%`);
  } else if (data.type === "result") {
    pendingGeneration?.resolve(data.candidates);
    pendingGeneration = null;
  } else if (data.type === "error") {
    pendingGeneration?.reject(new Error(data.message));
    pendingGeneration = null;
  }
});

async function generate({ regenerate = false } = {}) {
  const players = selectedPlayers();
  if (players.length !== 8) return showToast("참석자 8명을 먼저 선택해주세요.");
  const segregatedSlots = $$("input[name='segregatedSlot']:checked").map(({ value }) => Number(value));
  if (!segregatedSlots.length) return showToast("실력 분리 타임을 한 개 이상 선택해주세요.");
  state.seed = regenerate ? (state.seed ?? 0) + 1 : null;
  setLoading(true);
  try {
    const candidates = await runGeneration({
      players,
      sessions: activeSessions(),
      candidateCount: 3,
      seed: state.seed,
      segregatedSlots,
    });
    state.generatedPlayers = clone(players);
    state.candidates = candidates.map((candidate) => ({ ...candidate, undo: [], edited: false }));
    state.activeCandidate = 0;
    state.tapSource = null;
    setView("results");
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(false);
  }
}

function activeCandidate() {
  return state.candidates[state.activeCandidate] ?? null;
}

function candidateEvaluations() {
  return state.candidates.map((candidate) =>
    evaluateSchedule(candidate.schedule, state.generatedPlayers, activeSessions()),
  );
}

function renderCandidateTabs(evaluations) {
  const bestPenalty = Math.min(...evaluations.map((evaluation) => evaluation.metrics.totalPenalty));
  $("#candidateTabs").innerHTML = evaluations
    .map((evaluation, index) => {
      const difference = evaluation.metrics.totalPenalty - bestPenalty;
      const rank = 1 + evaluations.filter(
        (item) => item.metrics.totalPenalty < evaluation.metrics.totalPenalty,
      ).length;
      const candidate = state.candidates[index];
      return `
        <button
          type="button"
          class="candidate-tab ${index === state.activeCandidate ? "active" : ""}"
          data-candidate="${index}"
          role="tab"
          aria-selected="${index === state.activeCandidate}"
        >
          <span>후보 ${index + 1}${candidate.edited ? " · 수정됨" : ""}</span>
          <small>${difference === 0 ? "추천 · 낮은 벌점" : `${rank}순위 · 낮은 벌점 순`}</small>
        </button>`;
    })
    .join("");
}

function metricClass(value, warningAt = 1, dangerAt = Infinity) {
  if (value >= dangerAt) return "danger";
  if (value >= warningAt) return "warn";
  return "ok";
}

function renderEvaluation(evaluation, evaluations) {
  const metrics = evaluation.metrics;
  const bestPenalty = Math.min(...evaluations.map((item) => item.metrics.totalPenalty));
  const difference = metrics.totalPenalty - bestPenalty;
  const rank = 1 + evaluations.filter((item) => item.metrics.totalPenalty < metrics.totalPenalty).length;
  const validationClass = evaluation.validation.valid ? "ok" : "danger";
  const breakdown = Object.entries(evaluation.breakdown)
    .sort((left, right) => right[1] - left[1])
    .map(
      ([key, value]) => `
        <div class="breakdown-item">
          <span>${BREAKDOWN_LABELS[key]}</span><strong>${formatScore(value)}</strong>
        </div>`,
    )
    .join("");
  $("#evaluationCard").innerHTML = `
    <div class="evaluation-main">
      <span class="eyebrow">후보 ${state.activeCandidate + 1} 간단 평가</span>
      <h2>${escapeHtml(evaluation.headline)}</h2>
      <p>${difference === 0 ? "세 후보 중 벌점이 가장 낮은 추천 조합입니다." : `추천 후보보다 벌점이 ${formatScore(difference)} 더 많습니다.`}</p>
    </div>
    <div class="candidate-recommendation ${difference === 0 ? "best" : ""}">
      <strong>${difference === 0 ? "추천" : `${rank}순위`}</strong>
      <span>벌점 낮은 순</span>
    </div>
    <div class="metric-row metric-primary">
      <span class="metric-badge ${validationClass}">${escapeHtml(evaluation.validation.reason)}</span>
      <span class="metric-badge ${metricClass(metrics.maxTeamDifference, 1.5, 2.5)}">최대 팀 차 ${formatScore(metrics.maxTeamDifference)}</span>
      <span class="metric-badge ${metricClass(metrics.heavyCourtCount)}">일방적 코트 ${metrics.heavyCourtCount}</span>
    </div>
    <details class="breakdown">
      <summary>상세 평가 · 벌점 ${formatScore(metrics.totalPenalty)} (낮을수록 좋음)</summary>
      <div class="metric-row metric-secondary">
        <span class="metric-badge ${metricClass(metrics.duplicatePartnerCount)}">파트너 중복 ${metrics.duplicatePartnerCount}</span>
        <span class="metric-badge ${metricClass(metrics.duplicateOpponentCount, 5, 9)}">상대 중복 ${metrics.duplicateOpponentCount}</span>
        <span class="metric-badge ${metricClass(metrics.genderMismatchCount)}">성별 주의 ${metrics.genderMismatchCount}</span>
        <span class="metric-badge">최근 파트너 ${metrics.reusedPartnerCount}쌍 · 상대 ${metrics.reusedOpponentCount}쌍</span>
      </div>
      <div class="breakdown-grid">${breakdown}</div>
    </details>`;
}

function pathString(path) {
  return path.join("-");
}

function pathArray(value) {
  return value.split("-").map(Number);
}

function playerToken(player, path) {
  const selected = state.tapSource && pathString(state.tapSource) === pathString(path);
  return `
    <button
      type="button"
      class="player-token ${selected ? "tap-selected" : ""}"
      data-player-path="${pathString(path)}"
      aria-label="${escapeHtml(player.name)} · 눌러서 교환"
    >
      <span class="drag-handle" aria-hidden="true">⠿</span>
      <span class="player-name">${escapeHtml(player.name)}</span>
      <span class="level-badge">${escapeHtml(player.level)}</span>
    </button>`;
}

function renderSchedule(evaluation) {
  const candidate = activeCandidate();
  const players = state.generatedPlayers;
  $("#scheduleBoard").innerHTML = candidate.schedule
    .map((slot, slotIndex) => {
      const segregated = evaluation.metrics.segregatedSlots.includes(slotIndex);
      const courts = slot
        .map((court, courtIndex) => {
          const courtMetric = evaluation.courts.find(
            (item) => item.slotIndex === slotIndex && item.courtIndex === courtIndex,
          );
          const teams = court.map((team, teamIndex) =>
            team
              .map((playerIndex, playerIndexInTeam) =>
                playerToken(players[playerIndex], [slotIndex, courtIndex, teamIndex, playerIndexInTeam]),
              )
              .join(""),
          );
          return `
            <div class="court-row">
              <span class="court-badge">${courtIndex === 0 ? "K" : "L"}코트</span>
              <div class="team">${teams[0]}</div>
              <span class="vs">VS</span>
              <div class="team">${teams[1]}</div>
              <div class="court-metric">
                <strong>차이 ${formatScore(courtMetric.difference)}</strong>
                <span>${escapeHtml(courtMetric.matchType)}</span>
              </div>
            </div>`;
        })
        .join("");
      return `
        <article class="slot-card">
          <div class="slot-heading">
            <div><h3>${slotIndex + 1}타임</h3><p>${SLOT_LABELS[slotIndex]}</p></div>
            ${segregated ? '<span class="status-badge">실력 분리 타임</span>' : ""}
          </div>
          ${courts}
        </article>`;
    })
    .join("");
}

function renderResults() {
  const hasCandidates = state.candidates.length > 0;
  $("#resultEmpty").classList.toggle("hidden", hasCandidates);
  $("#resultContent").classList.toggle("hidden", !hasCandidates);
  $("#candidateTabs").classList.toggle("hidden", !hasCandidates);
  if (!hasCandidates) return;
  const evaluations = candidateEvaluations();
  const candidate = activeCandidate();
  candidate.evaluation = evaluations[state.activeCandidate];
  renderCandidateTabs(evaluations);
  renderEvaluation(candidate.evaluation, evaluations);
  renderSchedule(candidate.evaluation);
  $("#undoButton").disabled = candidate.undo.length === 0;
  $("#confirmButton").disabled = !candidate.evaluation.validation.valid;
}

function performSwap(source, target) {
  if (source[0] !== target[0]) return showToast("같은 타임 안에서만 자리를 바꿀 수 있습니다.");
  const candidate = activeCandidate();
  candidate.undo.push(clone(candidate.schedule));
  candidate.schedule = swapPlayers(candidate.schedule, source, target, state.generatedPlayers);
  candidate.edited = JSON.stringify(candidate.schedule) !== JSON.stringify(candidate.originalSchedule);
  state.tapSource = null;
  renderResults();
  showToast("두 선수의 자리를 바꾸고 다시 평가했습니다.");
}

function handleTokenTap(path) {
  if (state.suppressClick) return;
  if (!state.tapSource) {
    state.tapSource = path;
    renderResults();
    showToast("교환할 두 번째 선수를 눌러주세요.");
    return;
  }
  if (pathString(state.tapSource) === pathString(path)) {
    state.tapSource = null;
    renderResults();
    return;
  }
  performSwap(state.tapSource, path);
}

function beginDrag(event, handle) {
  const token = handle.closest(".player-token");
  if (!token) return;
  event.preventDefault();
  const ghost = token.cloneNode(true);
  ghost.classList.add("drag-ghost");
  ghost.removeAttribute("data-player-path");
  document.body.append(ghost);
  token.classList.add("drag-source");
  state.drag = {
    pointerId: event.pointerId,
    source: pathArray(token.dataset.playerPath),
    sourceToken: token,
    targetToken: null,
    ghost,
    moved: false,
  };
  handle.setPointerCapture?.(event.pointerId);
  moveGhost(event.clientX, event.clientY);
}

function moveGhost(x, y) {
  if (!state.drag) return;
  state.drag.ghost.style.left = `${x}px`;
  state.drag.ghost.style.top = `${y}px`;
}

function moveDrag(event) {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  event.preventDefault();
  state.drag.moved = true;
  moveGhost(event.clientX, event.clientY);
  state.drag.targetToken?.classList.remove("drop-target");
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".player-token");
  state.drag.targetToken = target && target !== state.drag.sourceToken ? target : null;
  if (state.drag.targetToken) {
    const targetPath = pathArray(state.drag.targetToken.dataset.playerPath);
    if (targetPath[0] === state.drag.source[0]) state.drag.targetToken.classList.add("drop-target");
  }
}

function finishDrag(event) {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  const drag = state.drag;
  drag.targetToken?.classList.remove("drop-target");
  drag.sourceToken.classList.remove("drag-source");
  drag.ghost.remove();
  state.drag = null;
  state.suppressClick = drag.moved;
  setTimeout(() => { state.suppressClick = false; }, 120);
  if (drag.targetToken) performSwap(drag.source, pathArray(drag.targetToken.dataset.playerPath));
}

function sessionCourts(session) {
  if (session.courts?.length) return session.courts;
  if (!session.schedule || !session.participants) return [];
  return session.schedule.flatMap((slot) =>
    slot.map((court) =>
      court.map((team) => team.map((index) => session.participants[index]?.name).filter(Boolean)),
    ),
  );
}

function sessionText(session) {
  if (session.text) return session.text;
  const courts = sessionCourts(session);
  const lines = [`## ${session.date} 코트운영`, ""];
  for (let index = 0; index < courts.length; index += 1) {
    if (index % 2 === 0) lines.push(SLOT_LABELS[index / 2] ?? `${index / 2 + 1}타임`);
    const [left, right] = courts[index];
    lines.push(`${index % 2 === 0 ? "K" : "L"}코트: ${left.join(" ")} vs ${right.join(" ")}`);
    if (index % 2 === 1) lines.push("");
  }
  return lines.join("\n").trim();
}

function renderHistory() {
  const sessions = [...state.sessions].sort((a, b) => b.date.localeCompare(a.date));
  const renderCards = (items, archived = false) => items
    .map((session) => {
      const courts = sessionCourts(session);
      const participantCount = session.participants?.length || new Set(courts.flat(2)).size;
      const slots = [0, 1, 2]
        .map((slotIndex) => {
          const pair = courts.slice(slotIndex * 2, slotIndex * 2 + 2);
          if (!pair.length) return "";
          return `
            <div class="history-slot">
              <strong>${slotIndex + 1}타임</strong>
              ${pair
                .map(
                  (court, courtIndex) =>
                    `<p>${courtIndex === 0 ? "K" : "L"} · ${escapeHtml(court[0].join("+"))} vs ${escapeHtml(court[1].join("+"))}</p>`,
                )
                .join("")}
            </div>`;
        })
        .join("");
      return `
        <article class="history-card ${archived ? "archived" : ""}">
          <div class="history-head">
            <div>
              <h2>${escapeHtml(formatDate(session.date))}</h2>
              <p>${participantCount}명 · ${escapeHtml(session.updatedBy ?? (session.status === "imported" ? "기존 history.md" : "확정 기록"))} · 버전 ${session.revision ?? 1}</p>
            </div>
            <div class="history-actions">
              ${archived ? "" : `<button class="secondary-button history-reuse" data-history-reuse="${session.date}" type="button">참석자 재사용</button>`}
              <details class="history-menu">
                <summary aria-label="${escapeHtml(formatDate(session.date))} 추가 작업">···</summary>
                <div class="history-menu-popover">
                  <button class="icon-button" data-history-copy="${session.date}" type="button">대진 복사</button>
                  <button class="icon-button" data-history-archive="${session.date}" type="button">${archived ? "현재 기록으로 복원" : "대진 보관"}</button>
                </div>
              </details>
            </div>
          </div>
          <details class="history-details">
            <summary>상세 대진 보기</summary>
            <div class="history-preview">${slots}</div>
          </details>
        </article>`;
    })
    .join("");
  const current = sessions.filter((session) => session.status !== "archived");
  const archived = sessions.filter((session) => session.status === "archived");
  const currentMarkup = current.length
    ? renderCards(current)
    : '<div class="history-empty">현재 사용 중인 확정 대진표가 없습니다.</div>';
  const archiveMarkup = archived.length
    ? `<details class="archive-section">
        <summary>보관된 대진 ${archived.length}개</summary>
        <div class="archived-list">${renderCards(archived, true)}</div>
      </details>`
    : "";
  $("#historyList").innerHTML = currentMarkup + archiveMarkup;
}

async function toggleSessionArchive(date) {
  const session = state.sessions.find((item) => item.date === date);
  if (!session) return;
  const restoring = session.status === "archived";
  const updated = clone(session);
  updated.status = restoring ? (session.statusBeforeArchive ?? "confirmed") : "archived";
  if (restoring) delete updated.statusBeforeArchive;
  else updated.statusBeforeArchive = session.status ?? "confirmed";
  delete updated.updatedAt;
  try {
    await state.store.saveSession(updated, session.revision ?? 0);
    showToast(restoring ? "대진을 현재 히스토리로 복원했습니다." : "대진을 보관하고 후보 계산에서 제외했습니다.");
  } catch (error) {
    showToast(error instanceof ConflictError ? `${error.message} 최신 기록을 확인해주세요.` : error.message);
  }
}

function reuseSession(date) {
  const session = state.sessions.find((item) => item.date === date);
  if (!session) return;
  const participantSnapshots = session.participants ?? [];
  const names = participantSnapshots.length
    ? participantSnapshots.map((participant) => participant.name)
    : [...new Set(sessionCourts(session).flat(2))];
  const matched = names
    .map((name) => state.members.find((member) => member.name === name))
    .filter(Boolean);
  state.selectedIds = matched.map((member) => member.id);
  state.guests = participantSnapshots
    .filter((participant) => !matched.some((member) => member.name === participant.name))
    .map((participant) => ({ ...participant, id: `guest-${crypto.randomUUID()}`, guest: true }));
  renderMembers();
  setView("participants");
  showToast(`${names.length}명의 참석자를 불러왔습니다.`);
}

async function copyText(text, successMessage = "대진표를 복사했습니다.") {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
  showToast(successMessage);
}

async function shareActiveCandidate() {
  const candidate = activeCandidate();
  if (!candidate) return;
  const text = scheduleToText(candidate.schedule, state.generatedPlayers, $("#matchDate").value);
  if (navigator.share) {
    try {
      await navigator.share({ title: "테니스 대진표", text });
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
    }
  }
  await copyText(text);
}

async function confirmActiveCandidate() {
  const candidate = activeCandidate();
  if (!candidate) return;
  const evaluation = evaluateSchedule(candidate.schedule, state.generatedPlayers, activeSessions());
  if (!evaluation.validation.valid) return showToast(evaluation.validation.reason);
  const date = $("#matchDate").value;
  const existing = state.sessions.find((session) => session.date === date);
  const participants = clone(state.generatedPlayers);
  const courts = candidate.schedule.flatMap((slot) =>
    slot.map((court) => court.map((team) => team.map((index) => participants[index].name))),
  );
  const session = {
    date,
    status: "confirmed",
    participants,
    schedule: clone(candidate.schedule),
    courts,
    evaluation,
    text: scheduleToText(candidate.schedule, participants, date),
    rulesVersion: state.seedData.rulesVersion,
  };
  $("#confirmButton").disabled = true;
  try {
    await state.store.saveSession(session, existing?.revision ?? 0);
    showToast("확정 대진을 공유 히스토리에 저장했습니다.");
    setView("history");
  } catch (error) {
    showToast(error instanceof ConflictError ? `${error.message} 최신 기록을 확인해주세요.` : error.message);
  } finally {
    $("#confirmButton").disabled = false;
  }
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function exportBackup() {
  try {
    const backup = await state.store.exportBackup();
    downloadJson(backup, `tennis-match-backup-${dateToInput(new Date())}.json`);
    showToast("회원과 대진 기록 백업을 내려받았습니다.");
  } catch (error) {
    showToast(error.message);
  }
}

async function addGuest(event) {
  event.preventDefault();
  const name = $("#guestName").value.trim();
  const gender = $("#guestGender").value;
  const level = $("#guestLevel").value;
  const score = Number(state.seedData.levels[level]);
  const save = $("#saveAsMember").checked;
  if (!name) return;
  if (!save && selectedPlayers().length >= 8) return showToast("참석자는 8명까지만 추가할 수 있습니다.");
  if (selectedPlayers().some((player) => player.name === name)) return showToast("이미 선택된 이름입니다.");

  const existingMember = state.members.find((member) => member.name === name);
  if (save && existingMember) {
    return showToast(existingMember.active === false ? "비활성 회원입니다. 회원 관리에서 다시 활성화해주세요." : "이미 등록된 회원입니다.");
  }
  const participant = {
    id: `${save ? "member" : "guest"}-${crypto.randomUUID()}`,
    name,
    gender,
    level,
    score,
    guest: !save,
    active: true,
  };
  try {
    if (save) {
      await state.store.saveMember(participant);
      state.members = [...state.members.filter((member) => member.id !== participant.id), participant];
      if (selectedPlayers().length < 8) state.selectedIds.push(participant.id);
    } else state.guests.push(participant);
    $("#guestDialog").close();
    $("#guestForm").reset();
    populateLevels();
    renderMembers();
    showToast(
      save
        ? selectedPlayers().some((player) => player.id === participant.id)
          ? "공유 회원으로 저장하고 참석자에 추가했습니다."
          : "공유 회원으로 저장했습니다. 참석자가 8명이라 자동 선택하지 않았습니다."
        : "일회성 게스트를 추가했습니다.",
    );
  } catch (error) {
    showToast(error.message);
  }
}

async function startDataSync() {
  state.stopSync?.();
  try {
    state.stopSync = await state.store.start({
      onMembers(members) {
        state.members = members;
        state.selectedIds = state.selectedIds.filter((id) =>
          members.some((member) => member.id === id && member.active !== false),
        );
        renderMembers();
      },
      onSessions(sessions) {
        state.sessions = sessions;
        if (!$("#matchDate").value) $("#matchDate").value = nextAvailableSunday(activeSessions());
        renderHistory();
      },
      onError(error) {
        showToast(`공유 데이터에 접근할 수 없습니다: ${error.message}`);
      },
    });
  } catch (error) {
    showToast(error.message);
  }
}

async function signInWithGoogle() {
  const button = $("#googleSignInButton");
  button.disabled = true;
  $("#loginError").textContent = "";
  try {
    await state.store.signInWithGoogle();
  } catch (error) {
    if (error.code !== "auth/popup-closed-by-user") {
      $("#loginError").textContent = "Google 로그인을 완료하지 못했습니다. 다시 시도해주세요.";
    }
  } finally {
    button.disabled = false;
  }
}

function wireEvents() {
  document.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) setView(viewButton.dataset.view);
    const memberButton = event.target.closest("[data-member-id]");
    if (memberButton) toggleMember(memberButton.dataset.memberId);
    const candidateButton = event.target.closest("[data-candidate]");
    if (candidateButton) {
      state.activeCandidate = Number(candidateButton.dataset.candidate);
      state.tapSource = null;
      renderResults();
    }
    const token = event.target.closest(".player-token");
    if (token && !event.target.closest(".drag-handle")) handleTokenTap(pathArray(token.dataset.playerPath));
    const historyCopy = event.target.closest("[data-history-copy]");
    if (historyCopy) {
      const session = state.sessions.find((item) => item.date === historyCopy.dataset.historyCopy);
      if (session) copyText(sessionText(session));
    }
    const historyReuse = event.target.closest("[data-history-reuse]");
    if (historyReuse) reuseSession(historyReuse.dataset.historyReuse);
    const historyArchive = event.target.closest("[data-history-archive]");
    if (historyArchive) toggleSessionArchive(historyArchive.dataset.historyArchive);
    const memberStatus = event.target.closest("[data-member-status]");
    if (memberStatus) toggleMemberStatus(memberStatus.dataset.memberStatus);
  });

  $("#memberSearch").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderMembers();
  });
  $("#memberFilters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    state.filter = button.dataset.filter;
    $$("[data-filter]", $("#memberFilters")).forEach((item) => item.classList.toggle("active", item === button));
    renderMembers();
  });
  $("#manageMembersButton").addEventListener("click", () => {
    state.manageMembers = !state.manageMembers;
    if (!state.manageMembers && state.filter === "inactive") state.filter = "all";
    $$('[data-filter]', $("#memberFilters")).forEach((item) =>
      item.classList.toggle("active", item.dataset.filter === state.filter),
    );
    renderMembers();
  });
  $("#openMemberButton").addEventListener("click", () => openParticipantDialog(true));
  $("#openGuestButton").addEventListener("click", () => openParticipantDialog(false));
  $("#guestDialogClose").addEventListener("click", () => $("#guestDialog").close());
  $("#guestForm").addEventListener("submit", addGuest);
  $("#bulkSelectForm").addEventListener("submit", selectMembersByName);
  $("#generateButton").addEventListener("click", () => generate());
  $("#regenerateButton").addEventListener("click", () => generate({ regenerate: true }));
  $("#undoButton").addEventListener("click", () => {
    const candidate = activeCandidate();
    if (!candidate?.undo.length) return;
    candidate.schedule = candidate.undo.pop();
    candidate.edited = JSON.stringify(candidate.schedule) !== JSON.stringify(candidate.originalSchedule);
    state.tapSource = null;
    renderResults();
  });
  $("#resetButton").addEventListener("click", () => {
    const candidate = activeCandidate();
    if (!candidate) return;
    candidate.undo.push(clone(candidate.schedule));
    candidate.schedule = clone(candidate.originalSchedule);
    candidate.edited = false;
    state.tapSource = null;
    renderResults();
  });
  $("#shareButton").addEventListener("click", shareActiveCandidate);
  $("#confirmButton").addEventListener("click", confirmActiveCandidate);
  $("#exportButton").addEventListener("click", exportBackup);
  $("#googleSignInButton").addEventListener("click", signInWithGoogle);
  $("#loginDialog").addEventListener("cancel", (event) => event.preventDefault());
  $("#signOutButton").addEventListener("click", () => state.store.signOut());

  document.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(".drag-handle");
    if (handle) beginDrag(event, handle);
  });
  document.addEventListener("pointermove", moveDrag, { passive: false });
  document.addEventListener("pointerup", finishDrag);
  document.addEventListener("pointercancel", finishDrag);
}

async function boot() {
  wireEvents();
  try {
    const response = await fetch("./data/app-data.json", { cache: "no-store" });
    if (!response.ok) throw new Error("초기 회원 데이터를 불러오지 못했습니다.");
    state.seedData = await response.json();
    state.members = clone(state.seedData.members);
    state.sessions = clone(state.seedData.sessions);
    populateLevels();
    $("#matchDate").value = nextAvailableSunday(activeSessions());
    renderMembers();
    renderHistory();
    state.store = await createStore(state.seedData);
    updateModeUi();
    state.store.onAuthStateChanged(async (user) => {
      state.user = user;
      updateModeUi();
      if (user) {
        if ($("#loginDialog").open) $("#loginDialog").close();
        await startDataSync();
      } else if (state.store.requiresAuth && !$("#loginDialog").open) {
        state.stopSync?.();
        $("#loginDialog").showModal();
      }
    });
  } catch (error) {
    showToast(error.message);
  }
}

boot();
