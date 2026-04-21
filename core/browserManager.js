const { getScreenSize } = require('../screen');
const { launchChromium } = require('../browser');

let browserInstance = null;
let launching = null;
let activeContextCount = 0;
let lastActivityAt = Date.now();
let idleTimer = null;

function getIdleMinutes() {
  const v = process.env.BROWSER_IDLE_MINUTES;
  if (v == null || v === '') return 10; // default: close browser if unused for 10 minutes
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 10;
  return n;
}

function touchActivity() {
  lastActivityAt = Date.now();
}

function ensureIdleTimer() {
  if (idleTimer) return;
  idleTimer = setInterval(async () => {
    const idleMinutes = getIdleMinutes();
    if (!browserInstance) return;
    if (idleMinutes === 0) return;
    if (activeContextCount > 0) return;
    const idleMs = Date.now() - lastActivityAt;
    if (idleMs < idleMinutes * 60 * 1000) return;
    try {
      await closeBrowser();
      console.log(`🧹 浏览器空闲超过 ${idleMinutes} 分钟，已自动退出以节省内存`);
    } catch {
      // ignore
    }
  }, 30 * 1000);
  // Don't keep Node alive just because of the idle timer.
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

async function getBrowser() {
  touchActivity();
  if (browserInstance) return browserInstance;
  if (launching) return launching;

  const screenSize = getScreenSize();
  launching = (async () => {
    const extraArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
    // Chromium blocks some "unsafe ports" (e.g. 445). Some proxy vendors use these ports.
    // Allow overriding so proxies like :445 can still work.
    const allowPorts =
      process.env.FMA_EXPLICITLY_ALLOWED_PORTS != null
        ? String(process.env.FMA_EXPLICITLY_ALLOWED_PORTS).trim()
        : '444,445';
    if (allowPorts) extraArgs.push(`--explicitly-allowed-ports=${allowPorts}`);

    const browser = await launchChromium({
      screenSize,
      trySystemChrome: true,
      extraArgs
    });

    browser.on('disconnected', () => {
      browserInstance = null;
      launching = null;
      activeContextCount = 0;
      console.log('🛑 浏览器已关闭（disconnected）');
    });

    browserInstance = browser;
    ensureIdleTimer();
    return browser;
  })();

  try {
    return await launching;
  } finally {
    launching = null;
  }
}

function trackContext(ctx) {
  if (!ctx || typeof ctx.on !== 'function') return ctx;
  activeContextCount += 1;
  touchActivity();
  try {
    ctx.on('close', () => {
      activeContextCount = Math.max(0, activeContextCount - 1);
      touchActivity();
    });
  } catch {
    // ignore
  }
  return ctx;
}

async function closeBrowser() {
  if (!browserInstance) return;
  const b = browserInstance;
  browserInstance = null;
  launching = null;
  activeContextCount = 0;
  await b.close();
}

function hasBrowser() {
  return Boolean(browserInstance);
}

module.exports = {
  getBrowser,
  trackContext,
  closeBrowser,
  hasBrowser
};
