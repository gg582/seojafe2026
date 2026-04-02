const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const sessionBtn = document.getElementById('sessionBtn');

let timer = null;
let currentDelayMs = 30000;

function isGitHubPagesHost() {
  return window.location.hostname.endsWith('github.io');
}

function log(message) {
  const ts = new Date().toLocaleString();
  statusEl.textContent = `[${ts}] ${message}\n` + statusEl.textContent;
}

function getIntervalMs() {
  const raw = Number(document.getElementById('intervalSec').value || 30);
  const sec = Number.isFinite(raw) ? Math.max(30, raw) : 30;
  return Math.floor(sec * 1000);
}

function scheduleNextCheck(delayMs) {
  if (timer) {
    clearTimeout(timer);
  }
  timer = setTimeout(runCheckCycle, delayMs);
}

async function notifySeatFound(cnt, openUrl) {
  if ('Notification' in window) {
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    if (Notification.permission === 'granted') {
      new Notification('멜론 좌석 감지!', { body: `남은 좌석 수: ${cnt}` });
    }
  }

  window.open(openUrl, '_blank', 'noopener,noreferrer');
}

async function refreshSession() {
  log('카카오 로그인 세션 갱신 시작...');

  const res = await fetch('/api/session/refresh', { method: 'POST' });
  const data = await res.json();

  if (!res.ok) {
    log(`세션 갱신 실패: ${data.error || 'unknown'}`);
    return false;
  }

  log(`세션 갱신 완료: ${data.updatedAt}`);
  return true;
}

async function checkSeat() {
  const payload = {
    prodId: document.getElementById('prodId').value.trim(),
    scheduleNo: document.getElementById('scheduleNo').value.trim(),
    seatId: document.getElementById('seatId').value.trim()
  };

  const res = await fetch('/api/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();

  if (!res.ok) {
    if (res.status === 429 && data.retryAfterMs) {
      const waitMs = Math.max(Number(data.retryAfterMs), getIntervalMs());
      log(`요청 제한: ${Math.ceil(waitMs / 1000)}초 후 재시도`);
      currentDelayMs = waitMs;
      return { ok: false, retry: true };
    }

    log(`에러: ${data.error || 'unknown'}`);
    currentDelayMs = Math.min(currentDelayMs * 2, 180000);
    return { ok: false, retry: true };
  }

  const cnt = Number(data.rmdSeatCnt || 0);
  log(`확인 완료: rmdSeatCnt=${cnt}`);

  if (cnt > 0) {
    const openUrl = document.getElementById('openUrl').value.trim() || 'https://ticket.melon.com/';
    await notifySeatFound(cnt, openUrl);
    return { ok: true, found: true };
  }

  currentDelayMs = getIntervalMs();
  return { ok: true, found: false };
}

async function runCheckCycle() {
  try {
    const result = await checkSeat();
    if (result.found) {
      stopWatch();
      return;
    }
    scheduleNextCheck(currentDelayMs);
  } catch (error) {
    log(`오류: ${String(error.message || error)}`);
    currentDelayMs = Math.min(currentDelayMs * 2, 180000);
    scheduleNextCheck(currentDelayMs);
  }
}

async function startWatch() {
  if (timer) {
    return;
  }

  if (isGitHubPagesHost()) {
    log('GitHub Pages는 정적 호스팅이라 /api 실행이 불가합니다. Node 서버(또는 서버리스 API) 주소에서 실행하세요.');
    return;
  }

  currentDelayMs = getIntervalMs();

  const ok = await refreshSession();
  if (!ok) {
    return;
  }

  log(`감시 시작 (${Math.floor(currentDelayMs / 1000)}초 간격)`);
  await runCheckCycle();
}

function stopWatch() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  log('감시 중지');
}

if (isGitHubPagesHost()) {
  log('현재 GitHub Pages에서 실행 중입니다. WASM을 써도 비밀값/세션 자동화는 브라우저에 노출되어 안전하지 않습니다.');
}

startBtn.addEventListener('click', startWatch);
stopBtn.addEventListener('click', stopWatch);
sessionBtn.addEventListener('click', refreshSession);
