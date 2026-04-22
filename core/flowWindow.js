const { getScreenSize, buildContextOptions } = require('../screen');
const browserManager = require('./browserManager');
const downloads = require('./downloads');
const proxyService = require('./proxyService');
const profiles = require('./profiles');
const proxyForwarder = require('./proxyForwarder');
const accountService = require('./accountService');
const singBox = require('./singBoxManager');
const time = require('./time');

const FLOW_URL = 'https://labs.google/fx/tools/flow';

let switchChain = Promise.resolve();

// Memory-only cache for managed/remote storageState (never written to disk).
const remoteStorageStateCache = new Map(); // name -> storageState

// sessionId -> session
const sessions = new Map();
let lastOpenedProfile = null;

function shouldLogProxyCreds() {
  return process.env.FMA_PROXY_LOG_CREDENTIALS === '1' || process.env.FMA_PROXY_DEBUG === '1';
}

function withSwitchLock(task) {
  const run = switchChain.then(task, task);
  switchChain = run.catch(() => {});
  return run;
}

function newSessionId(profile) {
  const p = String(profile || '').trim().replace(/[^\w.-]+/g, '_').slice(0, 40) || 'profile';
  const rnd = Math.random().toString(16).slice(2, 8);
  return `${p}-${Date.now()}-${rnd}`;
}

function maskProxyServer(server, proxy) {
  const raw = String(server || '').trim();
  if (!raw) return '—';
  const hasCred = proxy && (proxy.username || proxy.password);
  if (!hasCred) return raw.replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

function formatProxyUrlWithCred({ server, username, password } = {}) {
  const s = String(server || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  let u;
  try {
    u = new URL(s.includes('://') ? s : `http://${s}`);
  } catch {
    return s;
  }
  const user = username != null ? String(username) : '';
  const pass = password != null ? String(password) : '';
  if (!user && !pass) return `${u.protocol}//${u.host}`;
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`;
  return `${u.protocol}//${auth}@${u.host}`;
}

function scrubNetErrorMessage(message) {
  const s = String(message || '');
  if (!s) return s;
  // Playwright call logs can include sensitive headers (e.g. cookie). Strip those lines.
  return s
    .split('\n')
    .filter((line) => {
      const lower = line.trim().toLowerCase();
      if (lower.includes('proxy-authorization:')) return false;
      if (lower.includes('authorization:')) return false;
      if (lower.includes('cookie:')) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function singBoxListenPortBase() {
  const raw = process.env.FMA_SINGBOX_PORT;
  const n = raw != null ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0 && n <= 65535) return Math.floor(n);
  return 53182;
}

function buildSessionSummary(sess, { includeProxyDebug } = {}) {
  if (!sess) return null;
  return {
    id: sess.id,
    profile: sess.profile,
    createdAt: sess.createdAt || null,
    proxy: sess.proxyMeta || null,
    warning: sess.warning || null,
    proxyDebug: includeProxyDebug ? sess.proxyDebug || null : null,
  };
}

function getFlowState({ includeProxyDebug = false } = {}) {
  const list = Array.from(sessions.values())
    .map((s) => buildSessionSummary(s, { includeProxyDebug }))
    .filter(Boolean)
    .sort((a, b) => String(a.profile).localeCompare(String(b.profile), 'zh-CN'));
  return {
    lastOpenedProfile,
    sessionCount: list.length,
    sessions: list,
    hasBrowser: browserManager.hasBrowser(),
  };
}

async function focusFlowSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('invalid session id');
  const sess = sessions.get(id);
  if (!sess || !sess.page) throw new Error('session not found');
  try {
    await sess.page.bringToFront();
  } catch {
    // ignore
  }
  return { ok: true, id, profile: sess.profile };
}

async function closeFlowSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('invalid session id');
  const sess = sessions.get(id);
  if (!sess) return { ok: true, id, closed: false };
  try {
    await sess.context?.close();
  } catch {
    // ignore
  }
  return { ok: true, id, closed: true };
}

async function closeAllFlowWindows() {
  const ids = Array.from(sessions.keys());
  for (const id of ids) {
    try {
      await closeFlowSession(id);
    } catch {
      // ignore
    }
  }
}

async function quitBrowser() {
  return withSwitchLock(async () => {
    await closeAllFlowWindows();
    if (browserManager.hasBrowser()) await browserManager.closeBrowser();
    try {
      await singBox.stop();
    } catch {
      // ignore
    }
  });
}

async function openFlowWithProfile(profileName) {
  return withSwitchLock(async () => {
    const safeName = profiles.sanitizeProfileName(profileName);
    lastOpenedProfile = safeName;

    // One window per profile by default.
    for (const s of sessions.values()) {
      if (s && s.profile === safeName) {
        try {
          await s.page?.bringToFront();
        } catch {
          // ignore
        }
        return {
          sessionId: s.id,
          activeProfile: safeName,
          warning: s.warning || null,
          proxy: s.proxyMeta || null,
          reused: true,
        };
      }
    }

    let storageState;
    if (profiles.isNoLocalProfiles()) {
      if (remoteStorageStateCache.has(safeName)) {
        storageState = remoteStorageStateCache.get(safeName);
      } else {
        storageState = await accountService.downloadProfileStorageState(safeName);
        remoteStorageStateCache.set(safeName, storageState);
      }
    } else {
      storageState = profiles.readStorageState(safeName);
    }

    const screenSize = getScreenSize();
    const gotoTimeoutMs = process.env.GOTO_TIMEOUT_MS ? Number(process.env.GOTO_TIMEOUT_MS) : 120000;
    const navigationTimeout = Number.isFinite(gotoTimeoutMs) ? gotoTimeoutMs : 120000;
    const preflightUrl =
      (process.env.FMA_PROXY_PREFLIGHT_URL || '').trim() || 'https://www.google.com/generate_204';
    const preflightMethod = ((process.env.FMA_PROXY_PREFLIGHT_METHOD || '').trim() || 'GET').toUpperCase();

    let proxy = null;
    let node = null;
    let proxySource = null;
    let poolItemId = null;
    let nodeId = null;
    let proxyWarning;
    try {
      const r = await proxyService.getProxyForProfile(safeName);
      proxy = r?.proxy || null;
      node = r?.node || null;
      proxySource = r?.source || null;
      poolItemId = typeof r?.poolItemId === 'string' ? r.poolItemId : null;
      nodeId = typeof r?.nodeId === 'string' ? r.nodeId : null;
      if (r?.policyNoAvailable) {
        const items = typeof r?.policyItems === 'number' ? r.policyItems : null;
        const enabled = typeof r?.policyEnabled === 'number' ? r.policyEnabled : null;
        const missing = typeof r?.policyMissing === 'number' ? r.policyMissing : null;
        const disabled = typeof r?.policyDisabled === 'number' ? r.policyDisabled : null;
        const unusable = typeof r?.policyUnusable === 'number' ? r.policyUnusable : null;
        const extra = [
          missing != null ? `缺失 ${missing}` : null,
          disabled != null ? `已禁用 ${disabled}` : null,
          unusable != null ? `不可用 ${unusable}` : null,
        ]
          .filter(Boolean)
          .join('，');
        const w = `账号代理策略无可用条目（已绑定 ${items ?? '?'} 条，可用 ${enabled ?? 0} 条${extra ? `；${extra}` : ''}）：将直连打开（有风控风险，建议到管理端启用/替换该账号的代理条目）`;
        proxyWarning = proxyWarning ? `${proxyWarning}\n${w}` : w;
        console.warn(`⚠️ ${w}`);
      }
    } catch (err) {
      proxyWarning = `代理服务不可用/获取失败：${err.message || String(err)}（将直连打开）`;
      console.warn(`⚠️ ${proxyWarning}`);
    }

    const browser = await browserManager.getBrowser();

    let proxyForContext = proxy;
    let proxyVia = null;
    let nodeLease = null;
    let nodeTitle = null;

    if (!proxyForContext && node && node.fullLink) {
      try {
        nodeLease = await singBox.acquireForNodeLink(node.fullLink, {
          listenHost: '127.0.0.1',
          listenPort: singBoxListenPortBase(),
        });
        proxyForContext = nodeLease.proxy;
        proxyVia = nodeLease.via;
        nodeTitle = nodeLease.title;
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
        proxyVia = null;
        nodeTitle = null;
      }
    }

    if (
      proxy &&
      proxy.server &&
      (proxy.username || proxy.password) &&
      process.env.FMA_PROXY_AUTH_FORWARDER !== '0'
    ) {
      try {
        const u = new URL(String(proxy.server));
        if (u.protocol === 'http:') {
          const fwd = await proxyForwarder.getOrCreateForwarder(proxy);
          if (fwd?.server) {
            proxyVia = fwd.server;
            proxyForContext = { server: fwd.server, bypass: proxy.bypass };
          }
        }
      } catch {
        // ignore and use original proxy
      }
    }

    const id = newSessionId(safeName);
    const createdAt = time.nowIso();

    const ctx = browserManager.trackContext(
      await browser.newContext(buildContextOptions({ storageState, screenSize, proxy: proxyForContext }))
    );
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(navigationTimeout);
    downloads.hookContext(ctx);
    downloads.attachAutoSaveToPage(page);

    const sess = {
      id,
      profile: safeName,
      createdAt,
      context: ctx,
      page,
      nodeLease,
      proxyMeta: null,
      proxyDebug: null,
      warning: proxyWarning || null,
    };

    // Track the applied proxy (masked).
    if (proxy) {
      sess.proxyMeta = {
        source: proxySource || 'unknown',
        serverMasked: maskProxyServer(proxy.server, proxy),
        via: proxyVia ? String(proxyVia) : null,
        poolItemId: poolItemId || null,
        nodeId: nodeId || null,
      };
      sess.proxyDebug = {
        source: proxySource || 'unknown',
        via: proxyVia ? String(proxyVia) : null,
        upstream: {
          server: String(proxy.server || '').replace(/\/+$/, ''),
          username: proxy.username != null ? String(proxy.username) : '',
          password: proxy.password != null ? String(proxy.password) : '',
          bypass: proxy.bypass != null ? String(proxy.bypass) : '',
        },
        effective: proxyForContext
          ? {
              server: String(proxyForContext.server || '').replace(/\/+$/, ''),
              bypass: proxyForContext.bypass != null ? String(proxyForContext.bypass) : '',
            }
          : null,
      };
    } else if (nodeLease && node && proxyForContext) {
      sess.proxyMeta = {
        source: proxySource || 'node',
        serverMasked:
          nodeTitle ||
          String(node.remark || '').trim() ||
          `${String(node.protocol || '').trim() || 'node'} ${String(node.host || '').trim()}:${String(node.port || '').trim()}`,
        via: proxyVia ? String(proxyVia) : null,
        poolItemId: poolItemId || null,
        nodeId: nodeId || null,
      };
      sess.proxyDebug = {
        source: proxySource || 'node',
        via: proxyVia ? String(proxyVia) : null,
        upstream: {
          server: typeof node.fullLink === 'string' ? node.fullLink : '',
          username: '',
          password: '',
          bypass: '',
        },
        effective: proxyForContext
          ? {
              server: String(proxyForContext.server || '').replace(/\/+$/, ''),
              bypass: proxyForContext.bypass != null ? String(proxyForContext.bypass) : '',
            }
          : null,
      };
    }

    if (sess.proxyMeta) {
      const viaText = sess.proxyMeta.via ? `（本地转发：${sess.proxyMeta.via}）` : '';
      console.log(`🌐 已应用代理（${sess.proxyMeta.source}）：${sess.proxyMeta.serverMasked}${viaText}`);
      if (sess.proxyDebug && shouldLogProxyCreds()) {
        const upstream = sess.proxyDebug.upstream || {};
        const effective = sess.proxyDebug.effective || {};
        const upstreamFull = formatProxyUrlWithCred(upstream);
        console.log(`[代理调试] 上游：${upstreamFull || upstream.server || '—'}`);
        console.log(`[代理调试] 上游用户名：${upstream.username || ''}`);
        console.log(`[代理调试] 上游密码：${upstream.password || ''}`);
        console.log(
          `[代理调试] 有效代理：${String(effective.server || '').replace(/\/+$/, '') || '—'}${
            sess.proxyDebug.via ? `（本地转发：${sess.proxyDebug.via}）` : ''
          }`
        );
      }
    }

    // Cleanup on close
    sessions.set(id, sess);
    ctx.on('close', () => {
      sessions.delete(id);
      if (nodeLease && typeof nodeLease.release === 'function') {
        try {
          nodeLease.release().catch(() => {});
        } catch {
          // ignore
        }
      }
    });
    page.on('close', () => {
      try {
        ctx.close().catch(() => {});
      } catch {
        // ignore
      }
    });

    // Optional preflight: quickly check if the proxy can reach the internet.
    if (proxyForContext && process.env.FMA_PROXY_PREFLIGHT !== '0') {
      const preflightMs = process.env.FMA_PROXY_PREFLIGHT_TIMEOUT_MS
        ? Number(process.env.FMA_PROXY_PREFLIGHT_TIMEOUT_MS)
        : 6000;
      const ms = Number.isFinite(preflightMs) ? preflightMs : 6000;
      try {
        const res = await ctx.request.fetch(preflightUrl, { method: preflightMethod, timeout: ms });
        const st = res.status();
        if (!(st >= 200 && st < 400)) {
          const w = `代理连通性检查异常：HTTP ${st}（${preflightMethod} ${preflightUrl}）`;
          sess.warning = sess.warning ? `${sess.warning}\n${w}` : w;
          console.warn(`⚠️ ${w}`);
        }
      } catch (e) {
        const msg = scrubNetErrorMessage(e && e.message ? e.message : String(e));
        const w = `代理连通性检查失败：${msg}（${preflightMethod} ${preflightUrl}，超时时间 ${ms}ms）`;
        sess.warning = sess.warning ? `${sess.warning}\n${w}` : w;
        console.warn(`⚠️ ${w}`);
      }
    }

    let warning = sess.warning;
    let firstNetError = null;
    let flowHttpStatus = null;

    page.on('requestfailed', (req) => {
      if (firstNetError) return;
      try {
        const f = req.failure && typeof req.failure === 'function' ? req.failure() : null;
        const errText = f && f.errorText ? String(f.errorText) : '';
        if (!errText) return;
        firstNetError = `${errText}（${req.url()}）`;
      } catch {
        // ignore
      }
    });
    page.on('response', (resp) => {
      try {
        const url = resp.url();
        if (url === FLOW_URL) flowHttpStatus = resp.status();
      } catch {
        // ignore
      }
    });

    try {
      await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      const em = e && e.message ? String(e.message) : '';
      const detail = firstNetError ? `网络错误：${firstNetError}` : em ? `错误：${em}` : null;
      const httpHint = Number.isFinite(flowHttpStatus) ? `\nHTTP 状态码：${flowHttpStatus}` : '';
      const authHint =
        flowHttpStatus === 407
          ? `\n提示：代理返回 407（需要认证/认证失败）。如果 curl 可用但这里不行，建议开启“本地转发”并增大预检查超时。`
          : '';
      const w2 = `打开 ${FLOW_URL} 超时/失败（窗口已启动，可手动刷新/继续登录）。${detail ? `\n${detail}` : ''}${httpHint}`.trim();
      warning = warning ? `${warning}\n${w2}${authHint}` : `${w2}${authHint}`;
      sess.warning = warning;
      console.warn(`⚠️ ${warning}`);
    }

    try {
      await page.bringToFront();
    } catch {
      // ignore
    }

    console.log(`✅ 已打开账号: ${safeName}（多窗口）`);
    return { sessionId: id, activeProfile: safeName, warning: sess.warning || null, proxy: sess.proxyMeta || null };
  });
}

module.exports = {
  FLOW_URL,
  getFlowState,
  openFlowWithProfile,
  closeFlowSession,
  closeAllFlowWindows,
  focusFlowSession,
  quitBrowser,
};
