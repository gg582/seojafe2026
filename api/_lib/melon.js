const sessionState = {
  cookieHeader: '',
  updatedAt: null,
  lastError: null
};

const MIN_CHECK_INTERVAL_MS = Number(process.env.MIN_CHECK_INTERVAL_MS || 25000);
let lastSeatCheckAt = 0;

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


async function launchBrowser() {
  try {
    const { chromium } = await import('playwright');
    return chromium.launch({ headless: true });
  } catch (error) {
    const message = String(error?.message || error);
    const missingExecutable = message.includes('Executable doesn\'t exist');

    if (process.env.MELON_COOKIE) {
      return null;
    }

    if (missingExecutable) {
      throw new Error(
        'Playwright browser binary is missing. Run "npx playwright install chromium" (or "npx playwright install") in this environment, or set MELON_COOKIE as fallback.'
      );
    }

    throw new Error(`Playwright is not available: ${message}. Set MELON_COOKIE as fallback or install playwright + browser in runtime.`);
  }
}

export async function refreshSessionViaPlaywright() {
  const email = process.env.KAKAO_EMAIL;
  const pw = process.env.KAKAO_PW;

  if ((!email || !pw) && process.env.MELON_COOKIE) {
    sessionState.cookieHeader = process.env.MELON_COOKIE;
    sessionState.updatedAt = new Date().toISOString();
    sessionState.lastError = null;
    return { ok: true, updatedAt: sessionState.updatedAt, mode: 'env-cookie' };
  }

  if (!email || !pw) {
    throw new Error('KAKAO_EMAIL/KAKAO_PW environment variables are required (or set MELON_COOKIE).');
  }

  const loginUrl = process.env.KAKAO_LOGIN_URL
    || 'https://accounts.kakao.com/login/?continue=https%3A%2F%2Fticket.melon.com%2Fmain%2Findex.htm';

  const browser = await launchBrowser();

  if (!browser && process.env.MELON_COOKIE) {
    sessionState.cookieHeader = process.env.MELON_COOKIE;
    sessionState.updatedAt = new Date().toISOString();
    sessionState.lastError = null;
    return { ok: true, updatedAt: sessionState.updatedAt, mode: 'env-cookie' };
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.fill(process.env.KAKAO_EMAIL_SELECTOR || 'input[name="loginId"], input[name="email"]', email);
    await page.fill(process.env.KAKAO_PW_SELECTOR || 'input[name="password"]', pw);

    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => null),
      page.click(process.env.KAKAO_SUBMIT_SELECTOR || 'button[type="submit"]')
    ]);

    await page.goto('https://ticket.melon.com/main/index.htm', { waitUntil: 'networkidle', timeout: 120000 });

    const cookies = await context.cookies();
    const cookieHeader = makeCookieHeader(cookies);

    if (!cookieHeader.includes('JSESSIONID')) {
      throw new Error('JSESSIONID not found after login.');
    }

    sessionState.cookieHeader = cookieHeader;
    sessionState.updatedAt = new Date().toISOString();
    sessionState.lastError = null;

    return { ok: true, updatedAt: sessionState.updatedAt };
  } catch (error) {
    sessionState.lastError = String(error.message || error);
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

export function getSessionStatus() {
  return {
    hasCookie: Boolean(sessionState.cookieHeader),
    updatedAt: sessionState.updatedAt,
    lastError: sessionState.lastError
  };
}

export async function checkSeat({ prodId, scheduleNo, seatId = '5_0', volume = '1', selectedGradeVolume = '1' }) {
  if (!prodId || !scheduleNo) {
    return { status: 400, data: { error: 'prodId, scheduleNo are required' } };
  }

  const now = Date.now();
  const elapsed = now - lastSeatCheckAt;
  if (elapsed < MIN_CHECK_INTERVAL_MS) {
    const waitMs = MIN_CHECK_INTERVAL_MS - elapsed;
    return {
      status: 429,
      data: {
        error: 'Too many requests',
        message: `Please wait at least ${MIN_CHECK_INTERVAL_MS / 1000}s between checks`,
        retryAfterMs: waitMs
      }
    };
  }

  if (!sessionState.cookieHeader) {
    await refreshSessionViaPlaywright();
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
      Referer: 'https://ticket.melon.com/reservation/popup/stepTicket.htm',
      'User-Agent': 'Mozilla/5.0',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: form.toString()
  });

  const text = await upstream.text();

  if (!upstream.ok) {
    return {
      status: 502,
      data: { error: 'Upstream request failed', status: upstream.status, response: text.slice(0, 500) }
    };
  }

  const parsed = parseJsonp(text);
  return {
    status: 200,
    data: {
      ok: true,
      checkedAt: new Date(ts).toISOString(),
      rmdSeatCnt: Number(parsed.rmdSeatCnt ?? 0),
      raw: parsed
    }
  };
}
