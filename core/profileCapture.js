const { getScreenSize, buildContextOptions } = require('../screen');
const browserManager = require('./browserManager');
const downloads = require('./downloads');
const proxyService = require('./proxyService');
const profiles = require('./profiles');
const singBox = require('./singBoxManager');

const FLOW_URL = 'https://labs.google/fx/tools/flow';

let captureContext = null;
let capturePage = null;
let captureProfile = null;
let captureNodeLease = null;

function singBoxListenPort() {
  const raw = process.env.FMA_SINGBOX_PORT;
  const n = raw != null ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0 && n <= 65535) return Math.floor(n);
  return 53182;
}

function getCaptureState() {
  return {
    inProgress: Boolean(captureContext),
    profileName: captureProfile
  };
}

async function startCapture(profileName) {
  const name = profiles.sanitizeProfileName(profileName);
  if (captureContext) throw new Error('已有正在进行的保存流程');

  const screenSize = getScreenSize();
  const gotoTimeoutMs = process.env.GOTO_TIMEOUT_MS ? Number(process.env.GOTO_TIMEOUT_MS) : 120000;
  const navigationTimeout = Number.isFinite(gotoTimeoutMs) ? gotoTimeoutMs : 120000;

  let proxy = null;
  let node = null;
  let proxyWarning;
  try {
    const r = await proxyService.getProxyForProfile(name);
    proxy = r?.proxy || null;
    node = r?.node || null;
  } catch (err) {
    proxyWarning = `代理服务不可用/获取失败：${err.message || String(err)}（将直连打开）`;
    console.warn(`⚠️ ${proxyWarning}`);
  }

  const browser = await browserManager.getBrowser();
  let proxyForContext = proxy;
  let nodeLease = null;
  if (!proxyForContext && node && node.fullLink) {
    try {
      nodeLease = await singBox.acquireForNodeLink(node.fullLink, {
        listenHost: '127.0.0.1',
        listenPort: singBoxListenPort()
      });
      proxyForContext = nodeLease.proxy;
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      const w = `节点代理启动失败：${msg}（将直连打开）`;
      proxyWarning = proxyWarning ? `${proxyWarning}\n${w}` : w;
      console.warn(`⚠️ ${w}`);
      try {
        if (nodeLease && typeof nodeLease.release === 'function') await nodeLease.release();
      } catch {
        // ignore
      }
      nodeLease = null;
      proxyForContext = null;
    }
  }

  try {
    captureContext = browserManager.trackContext(
      await browser.newContext(buildContextOptions({ screenSize, proxy: proxyForContext }))
    );
  } catch (e) {
    try {
      if (nodeLease && typeof nodeLease.release === 'function') await nodeLease.release();
    } catch {
      // ignore
    }
    throw e;
  }
  captureNodeLease = nodeLease;
  if (nodeLease && typeof nodeLease.release === 'function') {
    const lease = nodeLease;
    captureContext.on('close', () => {
      try {
        lease.release().catch(() => {});
      } catch {
        // ignore
      }
      if (captureNodeLease === lease) captureNodeLease = null;
    });
  }
  capturePage = await captureContext.newPage();
  capturePage.setDefaultNavigationTimeout(navigationTimeout);
  captureProfile = name;
  downloads.hookContext(captureContext);
  downloads.attachAutoSaveToPage(capturePage);

  let warning = proxyWarning;
  try {
    await capturePage.goto(FLOW_URL, { waitUntil: 'domcontentloaded' });
  } catch {
    const w2 = `打开 ${FLOW_URL} 超时/失败（窗口已启动，可手动刷新后继续）。`;
    warning = warning ? `${warning}\n${w2}` : w2;
    console.warn(`⚠️ ${warning}`);
  }

  try {
    await capturePage.bringToFront();
  } catch {
    // ignore
  }

  console.log(`🧾 开始保存账号: ${name}`);
  return { profileName: name, warning };
}

async function finishCapture() {
  if (!captureContext || !captureProfile) throw new Error('当前没有正在保存的账号');
  const ctx = captureContext;
  const name = captureProfile;

  if (profiles.isNoLocalProfiles()) {
    await cancelCapture();
    throw new Error('已开启无落盘模式：不会在本机保存账号登录态（请联系管理员在管理端保存/分配账号）');
  }

  const storageState = await ctx.storageState();
  profiles.writeStorageState(name, storageState);

  await cancelCapture();
  console.log(`✅ 已保存账号: ${name}`);
  return { profileName: name };
}

async function cancelCapture() {
  const ctx = captureContext;
  const lease = captureNodeLease;
  captureContext = null;
  capturePage = null;
  captureProfile = null;
  captureNodeLease = null;

  if (!ctx) {
    try {
      if (lease && typeof lease.release === 'function') await lease.release();
    } catch {
      // ignore
    }
    return;
  }
  try {
    await ctx.close();
  } catch {
    // ignore
  } finally {
    try {
      if (lease && typeof lease.release === 'function') await lease.release();
    } catch {
      // ignore
    }
  }
}

module.exports = {
  getCaptureState,
  startCapture,
  finishCapture,
  cancelCapture
};
