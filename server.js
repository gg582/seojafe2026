import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const sessionState = {
  cookieHeader: '',
  updatedAt: null,
  lastError: null
};

const MIN_CHECK_INTERVAL_MS = Number(process.env.MIN_CHECK_INTERVAL_MS || 25000);
let lastSeatCheckAt = 0;

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body || '{}');
  } catch {
    return null;
  }
}

function parseJsonp(jsonpText) {
  const start = jsonpText.indexOf('(');
  const end = jsonpText.lastIndexOf(')');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Invalid JSONP response');
  }
  return JSON.parse(jsonpText.slice(start + 1, end));
}

function makeCookieHeader(cookies) {
  return cookies
    .filter((cookie) => cookie.name && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function refreshSessionViaPlaywright() {
  const email = process.env.KAKAO_EMAIL;
  const pw = process.env.KAKAO_PW;

  if (!email || !pw) {
    throw new Error('KAKAO_EMAIL/KAKAO_PW 환경변수가 필요합니다.');
  }

  const { chromium } = await import('playwright');

  const loginUrl = process.env.KAKAO_LOGIN_URL
    || 'https://accounts.kakao.com/login/?continue=https%3A%2F%2Fticket.melon.com%2Fmain%2Findex.htm';
  const idSelector = process.env.KAKAO_EMAIL_SELECTOR || 'input[name="loginId"], input[name="email"]';
  const pwSelector = process.env.KAKAO_PW_SELECTOR || 'input[name="password"]';
  const submitSelector = process.env.KAKAO_SUBMIT_SELECTOR || 'button[type="submit"]';

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector(idSelector, { timeout: 30000 });
    await page.fill(idSelector, email);
    await page.fill(pwSelector, pw);

    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => null),
      page.click(submitSelector)
    ]);

    await page.goto('https://ticket.melon.com/main/index.htm', { waitUntil: 'networkidle', timeout: 120000 });

    const cookies = await context.cookies();
    const cookieHeader = makeCookieHeader(cookies);

    if (!cookieHeader.includes('JSESSIONID')) {
      throw new Error('로그인 후 유효 쿠키(JSESSIONID)를 찾지 못했습니다. selector 또는 로그인 흐름 확인 필요.');
    }

    sessionState.cookieHeader = cookieHeader;
    sessionState.updatedAt = new Date().toISOString();
    sessionState.lastError = null;

    return {
      ok: true,
      updatedAt: sessionState.updatedAt
    };
  } catch (error) {
    sessionState.lastError = String(error.message || error);
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

async function handleRefreshSession(_req, res) {
  try {
    const result = await refreshSessionViaPlaywright();
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, { error: String(error.message || error), hint: '2FA/CAPTCHA/선택자 변경 시 수동 대응이 필요할 수 있습니다.' });
  }
}

async function handleSessionStatus(_req, res) {
  sendJson(res, 200, {
    hasCookie: Boolean(sessionState.cookieHeader),
    updatedAt: sessionState.updatedAt,
    lastError: sessionState.lastError
  });
}

async function handleSeatCheck(req, res) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }

  const payload = parseJsonBody(body);
  if (!payload) {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const {
    prodId,
    scheduleNo,
    seatId = '5_0',
    volume = '1',
    selectedGradeVolume = '1',
    referer = 'https://ticket.melon.com/reservation/popup/stepTicket.htm'
  } = payload;

  if (!prodId || !scheduleNo) {
    sendJson(res, 400, { error: 'prodId, scheduleNo are required' });
    return;
  }

  const now = Date.now();
  const elapsed = now - lastSeatCheckAt;
  if (elapsed < MIN_CHECK_INTERVAL_MS) {
    const waitMs = MIN_CHECK_INTERVAL_MS - elapsed;
    sendJson(res, 429, {
      error: 'Too many requests',
      message: `요청 간격을 늘려주세요. 최소 ${MIN_CHECK_INTERVAL_MS / 1000}초 간격 권장`,
      retryAfterMs: waitMs
    });
    return;
  }

  if (!sessionState.cookieHeader) {
    try {
      await refreshSessionViaPlaywright();
    } catch (error) {
      sendJson(res, 500, { error: `세션 갱신 실패: ${String(error.message || error)}` });
      return;
    }
  }

  const ts = Date.now();
  const callback = `jQuerySeatWatcher_${ts}`;
  const url = new URL('https://ticket.melon.com/tktapi/product/seatStateInfo.json');
  url.searchParams.set('v', '1');
  url.searchParams.set('callback', callback);

  const form = new URLSearchParams({
    prodId: String(prodId),
    scheduleNo: String(scheduleNo),
    seatId: String(seatId),
    volume: String(volume),
    selectedGradeVolume: String(selectedGradeVolume)
  });

  lastSeatCheckAt = Date.now();

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'text/javascript, application/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Cookie: sessionState.cookieHeader,
      Origin: 'https://ticket.melon.com',
      Referer: referer,
      'User-Agent': 'Mozilla/5.0',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: form.toString()
  });

  const text = await upstream.text();

  if (!upstream.ok) {
    sendJson(res, 502, {
      error: 'Upstream request failed',
      status: upstream.status,
      response: text.slice(0, 500)
    });
    return;
  }

  try {
    const parsed = parseJsonp(text);
    sendJson(res, 200, {
      ok: true,
      checkedAt: new Date(ts).toISOString(),
      rmdSeatCnt: Number(parsed.rmdSeatCnt ?? 0),
      raw: parsed
    });
  } catch (error) {
    sendJson(res, 500, { error: String(error.message || error), response: text.slice(0, 500) });
  }
}

async function serveStatic(res, relPath) {
  const cleanPath = relPath === '/' ? '/index.html' : relPath;
  const filePath = path.join(PUBLIC_DIR, cleanPath);
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    const contentType =
      ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.js' ? 'application/javascript; charset=utf-8'
          : ext === '.css' ? 'text/css; charset=utf-8'
            : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/api/session/refresh') {
    await handleRefreshSession(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/session/status') {
    await handleSessionStatus(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/check') {
    try {
      await handleSeatCheck(req, res);
    } catch (error) {
      sendJson(res, 500, { error: String(error.message || error) });
    }
    return;
  }

  if (req.method === 'GET') {
    await serveStatic(res, url.pathname);
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method Not Allowed');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Seat watcher running: http://localhost:${PORT}`);
});
