# 운영자 2명용 Firebase 연결 안내

사이트는 Firebase 설정 전에도 **로컬 데모 모드**로 전부 시험할 수 있습니다.
실제 운영에 들어갈 때 아래 순서로 한 번만 연결하면 두 운영자가 같은 회원과
대진 히스토리를 보게 됩니다.

## 운영자가 사이트를 사용하는 방식

1. 사이트 주소를 엽니다.
2. 각 운영자가 자신의 Google 계정으로 로그인합니다.
3. 두 운영자는 같은 회원 명단과 확정 대진을 봅니다.
4. 후보 계산과 드래그 편집은 각 휴대폰 안에서 빠르게 처리됩니다.
5. `이 대진 확정`을 눌렀을 때만 Firestore에 공유 기록이 저장됩니다.
6. 다른 운영자의 화면에도 확정 기록이 자동으로 반영됩니다.

회원 비활성화와 대진 보관은 데이터를 완전히 삭제하지 않습니다. 비활성 회원은
참석자 선택에서 숨겨지고, 보관된 대진은 최근 파트너·상대 이력 계산에서 제외됩니다.
두 기능 모두 사이트에서 다시 활성화하거나 복원할 수 있습니다.

공개 회원가입 화면은 만들지 않았습니다. Google 로그인에 성공하더라도 아래의
`operators/{UID}` 허용 목록에 등록된 두 계정만 공유 데이터에 접근할 수 있습니다.

## 1. Firebase 프로젝트 만들기

1. <https://console.firebase.google.com/> 에서 프로젝트를 하나 만듭니다.
2. **Authentication → Sign-in method**에서 `Google`을 켜고 공개용 이름과 지원 이메일을 설정합니다.
3. **Firestore Database**를 만들고 운영 지역을 선택합니다.

## 2. 운영자 허용 목록 만들기

배포된 사이트에서 두 운영자가 각자 Google 로그인을 한 번씩 시도한 뒤,
Authentication의 사용자 표에서 각 운영자의 `User UID`를 복사합니다. 허용 목록을
등록하기 전 첫 로그인에서는 공유 데이터 접근 오류가 표시되는 것이 정상입니다.
Firestore에서 `operators` 컬렉션을 만들고 UID와 같은 이름의 문서를 두 개
추가합니다. 문서에는 확인용으로 `email` 필드만 넣으면 됩니다.

```text
operators/{첫 번째 운영자 UID}
  email: first@example.com

operators/{두 번째 운영자 UID}
  email: second@example.com
```

이 문서가 있는 계정만 회원 및 대진 데이터를 읽고 쓸 수 있습니다.

## 3. 웹 앱 설정값 연결하기

Firebase 콘솔의 **Project settings → Your apps → Web app**에서 설정값을
복사해 `docs/assets/firebase-config.js`에 넣습니다.

```js
export const FIREBASE_SETTINGS = Object.freeze({
  enabled: true,
  sdkVersion: "11.10.0",
  project: {
    apiKey: "...",
    authDomain: "...",
    projectId: "...",
    storageBucket: "...",
    messagingSenderId: "...",
    appId: "...",
  },
});
```

웹 설정값의 `apiKey`는 서버 비밀번호가 아닙니다. 실제 데이터 보호는 로그인과
Firestore Security Rules가 담당합니다. `service account` 또는 `service role`
키는 절대 웹 파일에 넣으면 안 됩니다.

## 4. 보안 규칙 적용하기

Firebase 콘솔의 **Firestore Database → Rules**에서
`firebase/firestore.rules`의 내용을 붙여넣고 Publish를 누릅니다.

Firebase CLI를 쓰는 경우 저장소 루트에서 아래 명령으로도 배포할 수 있습니다.

```bash
firebase deploy --only firestore:rules
```

## 5. 첫 로그인

첫 운영자가 로그인하면 기존 `members.csv`와 `history.md`에서 만든 초기 데이터를
Firestore로 한 번만 가져옵니다. 그 이후에는 Firestore 데이터가 두 운영자의
공통 원본이 됩니다.

같은 날짜를 두 운영자가 동시에 수정하면 먼저 저장된 버전을 덮어쓰지 않고
충돌 안내를 표시합니다. 기존 버전은 `sessions/{날짜}/revisions`에 보관됩니다.
