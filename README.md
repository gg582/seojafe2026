# Melon Seat Watcher

## Local run

1) Install
```bash
npm install
npx playwright install chromium
```

2) Set env
```bash
export KAKAO_EMAIL="your_kakao_email@example.com"
export KAKAO_PW="your_kakao_password"
```

3) Run
```bash
npm start
```
Open: http://localhost:3000

## GitHub Pages hosting

This repo includes a Pages deployment workflow (`.github/workflows/pages.yml`) that publishes the `public/` folder.

1) GitHub **Environment**: `KAKAO_EMAIL` 생성
2) 해당 Environment 아래 Secret 추가
- `KAKAO_EMAIL`
- `KAKAO_PW`
3) GitHub Pages source를 **GitHub Actions**로 설정
4) `main` push 또는 workflow_dispatch 실행

## 왜 WASM으로도 Pages 한계가 그대로인가?

- WASM은 브라우저 안에서 돌아갑니다. 즉 정적 JS와 동일하게 **클라이언트 코드**입니다.
- 브라우저 코드(WASM/JS)는 GitHub Secrets를 직접 읽을 수 없습니다.
- 브라우저에서 로그인/세션 토큰을 처리하면 사용자에게 노출되어 보안상 안전하지 않습니다.
- `/api/*` 같은 서버 엔드포인트가 없으면 CORS/세션/보안 정책 때문에 안정적인 자동화가 어렵습니다.

결론: WASM은 속도/로직 이식에는 도움되지만, **서버 비밀값 보관과 세션 자동화 대체수단은 아닙니다.**

## Safe-usage defaults

- 기본 체크 간격은 30초입니다.
- 서버에서 최소 요청 간격(`MIN_CHECK_INTERVAL_MS`, 기본 25000ms) 제한을 적용합니다.
- 요청 실패 시 클라이언트는 자동 백오프(최대 180초)로 재시도합니다.

## Important

- GitHub Pages는 정적 호스팅입니다. Playwright 로그인/세션 생성은 Pages에서 실행되지 않습니다.
- 실제 자동 로그인/좌석 API 호출은 `server.js`가 실행되는 Node 환경에서만 동작합니다.
- 서비스 약관/정책을 준수하고 과도한 요청을 피하세요.
