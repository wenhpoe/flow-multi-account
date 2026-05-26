const fs = require('fs');
const path = require('path');

const controlPlane = require('./controlPlane');
const deviceState = require('./deviceState');
const { writeJsonAtomicSync } = require('./fsAtomic');

const deviceValidationCache = {
  key: '',
  checkedAtMs: 0,
  result: null,
  promise: null,
};

function authHeaders() {
  const s = deviceState.readDeviceState();
  if (!s.token) throw new Error('设备未激活');
  return { Authorization: `Bearer ${s.token}` };
}

function invalidateDeviceValidation() {
  deviceValidationCache.key = '';
  deviceValidationCache.checkedAtMs = 0;
  deviceValidationCache.result = null;
  deviceValidationCache.promise = null;
}

function buildDeviceAccessResult({
  state = 'activation-required',
  canUseApp = false,
  needsActivation = false,
  message = '',
  machineId = null,
  serverUrl = null,
  checkedAt = new Date().toISOString(),
  localActivated = false,
  serverValidated = false,
  allowedProfiles = [],
  activatedAt = null,
  lastSeenAt = null,
} = {}) {
  return {
    state,
    canUseApp: Boolean(canUseApp),
    needsActivation: Boolean(needsActivation),
    message: String(message || '').trim() || null,
    machineId: machineId ? String(machineId) : null,
    serverUrl: serverUrl ? String(serverUrl) : null,
    checkedAt: checkedAt || null,
    localActivated: Boolean(localActivated),
    serverValidated: Boolean(serverValidated),
    allowedProfiles: Array.isArray(allowedProfiles)
      ? allowedProfiles.map((s) => String(s).trim()).filter(Boolean)
      : [],
    activatedAt: activatedAt || null,
    lastSeenAt: lastSeenAt || null,
  };
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...headers },
      body,
      signal: controller.signal,
    });
    // If the server resets this device, tokens become invalid. Clear local token so the client returns to activation UI.
    if (res.status === 401) {
      try {
        deviceState.writeDeviceState({ token: null, allowedProfiles: [] });
      } catch {
        // ignore
      }
      invalidateDeviceValidation();
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data && data.error ? data.error : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  } catch (err) {
    if (err && typeof err === 'object' && err.name === 'AbortError') {
      throw new Error('请求超时：请检查服务地址是否正确、服务是否可访问');
    }
    // Node/Electron fetch network failures usually surface as TypeError: fetch failed
    if (err instanceof TypeError) {
      const code = err?.cause?.code;
      if (code === 'ENOTFOUND') throw new Error('无法解析服务地址：请检查地址是否输入正确');
      if (code === 'ECONNREFUSED') throw new Error('连接被拒绝：服务未启动或端口不可达');
      if (code === 'ETIMEDOUT') throw new Error('连接超时：请检查网络/防火墙或服务端状态');
      throw new Error('无法连接到管理服务：请检查服务地址、网络与防火墙');
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function activateDevice({ machineId, activationCode, serverUrl }) {
  const base = deviceState.normalizeUrl(serverUrl || controlPlane.getBaseUrl());
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error('服务地址格式不正确：请填写类似 http://192.168.1.10:3123');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('服务地址协议不支持：仅支持 http/https');
  if (parsed.hostname === '0.0.0.0') {
    throw new Error('服务地址不能使用 0.0.0.0：请改用管理员电脑的局域网 IP 或 127.0.0.1');
  }
  const url = `${base}/v1/client/activate`;
  const data = await fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ machineId, activationCode }),
    timeoutMs: 8000,
  });
  if (!data?.token) throw new Error('激活失败：无 token');
  deviceState.writeDeviceState({ serverUrl: base, token: data.token });
  invalidateDeviceValidation();
  return { machineId, serverUrl: base };
}

async function validateDeviceAccess({ force = false, maxAgeMs = 15000 } = {}) {
  const s = deviceState.readDeviceState();
  const machineId = String(s.machineId || '').trim() || null;
  const serverUrl = deviceState.normalizeUrl(s.serverUrl || controlPlane.getBaseUrl());
  const localActivated = Boolean(machineId && s.token);

  if (!machineId) {
    invalidateDeviceValidation();
    return buildDeviceAccessResult({
      state: 'activation-required',
      canUseApp: false,
      needsActivation: true,
      message: '当前设备缺少机器码，请重启应用后重试。',
      machineId: null,
      serverUrl,
      localActivated: false,
    });
  }

  if (!localActivated) {
    invalidateDeviceValidation();
    return buildDeviceAccessResult({
      state: 'activation-required',
      canUseApp: false,
      needsActivation: true,
      message: '请输入激活码并完成校验后再进入主页。',
      machineId,
      serverUrl,
      localActivated: false,
    });
  }

  const cacheKey = `${machineId}:${String(s.token)}:${serverUrl}`;
  if (!force && deviceValidationCache.promise && deviceValidationCache.key === cacheKey) {
    return deviceValidationCache.promise;
  }
  if (
    !force &&
    deviceValidationCache.result &&
    deviceValidationCache.key === cacheKey &&
    Date.now() - deviceValidationCache.checkedAtMs < maxAgeMs
  ) {
    return deviceValidationCache.result;
  }

  deviceValidationCache.key = cacheKey;
  let pending = null;
  pending = (async () => {
    try {
      const data = await fetchJson(`${serverUrl}/v1/client/device`, {
        headers: { ...authHeaders() },
        timeoutMs: 6000,
      });
      const allowedProfiles = Array.isArray(data?.allowedProfiles)
        ? data.allowedProfiles.map((item) => String(item).trim()).filter(Boolean)
        : [];
      try {
        deviceState.writeDeviceState({ serverUrl, allowedProfiles });
      } catch {
        // ignore
      }
      const result = buildDeviceAccessResult({
        state: 'active',
        canUseApp: true,
        needsActivation: false,
        message: '设备已通过管理服务校验。',
        machineId,
        serverUrl,
        localActivated: true,
        serverValidated: true,
        allowedProfiles,
        activatedAt: data?.activatedAt || null,
        lastSeenAt: data?.lastSeenAt || null,
      });
      deviceValidationCache.result = result;
      deviceValidationCache.checkedAtMs = Date.now();
      return result;
    } catch (err) {
      const latest = deviceState.readDeviceState();
      const stillActivated = Boolean(latest.machineId && latest.token);
      const result = stillActivated
        ? buildDeviceAccessResult({
            state: 'validation-error',
            canUseApp: false,
            needsActivation: false,
            message: err?.message || '无法验证激活状态，请检查管理服务。',
            machineId: latest.machineId || machineId,
            serverUrl: deviceState.normalizeUrl(latest.serverUrl || serverUrl),
            localActivated: true,
            serverValidated: false,
            allowedProfiles: latest.allowedProfiles || [],
          })
        : buildDeviceAccessResult({
            state: 'activation-required',
            canUseApp: false,
            needsActivation: true,
            message: '当前设备激活已失效，请重新输入激活码。',
            machineId: latest.machineId || machineId,
            serverUrl: deviceState.normalizeUrl(latest.serverUrl || serverUrl),
            localActivated: false,
            serverValidated: false,
          });
      deviceValidationCache.result = result;
      deviceValidationCache.checkedAtMs = Date.now();
      return result;
    } finally {
      if (deviceValidationCache.promise === pending) deviceValidationCache.promise = null;
    }
  })();

  deviceValidationCache.promise = pending;
  return pending;
}

async function listAllowedProfiles() {
  const base = controlPlane.getBaseUrl();
  const url = `${base}/v1/client/profiles`;
  const data = await fetchJson(url, { headers: { ...authHeaders() }, timeoutMs: 8000 });
  const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
  return { profiles, missing: data?.missing || [] };
}

async function downloadProfileStorageState(profileName) {
  const base = controlPlane.getBaseUrl();
  const url = `${base}/v1/client/profiles/${encodeURIComponent(profileName)}`;
  const data = await fetchJson(url, { headers: { ...authHeaders() }, timeoutMs: 12000 });
  const storageState = data?.storageState;
  if (!storageState || typeof storageState !== 'object') throw new Error('无效 storageState');
  return storageState;
}

async function fullSyncToDir(dstDir, { removeExtra = true } = {}) {
  fs.mkdirSync(dstDir, { recursive: true });

  const { profiles } = await listAllowedProfiles();
  const allowedNames = profiles.map((p) => p.name);

  // Download sequentially (safe). Can be parallelized later if needed.
  let downloaded = 0;
  for (const name of allowedNames) {
    const storageState = await downloadProfileStorageState(name);
    writeJsonAtomicSync(path.join(dstDir, `${name}.json`), storageState);
    downloaded += 1;
  }

  let removed = 0;
  if (removeExtra) {
    const existing = fs.readdirSync(dstDir).filter((f) => f.toLowerCase().endsWith('.json'));
    const allowedFiles = new Set(allowedNames.map((n) => `${n}.json`));
    for (const f of existing) {
      if (!allowedFiles.has(f)) {
        try {
          fs.unlinkSync(path.join(dstDir, f));
          removed += 1;
        } catch {
          // ignore
        }
      }
    }
  }

  deviceState.writeDeviceState({ allowedProfiles: allowedNames });
  return { downloaded, removed, allowedProfiles: allowedNames };
}

module.exports = {
  activateDevice,
  invalidateDeviceValidation,
  listAllowedProfiles,
  downloadProfileStorageState,
  fullSyncToDir,
  validateDeviceAccess,
};
