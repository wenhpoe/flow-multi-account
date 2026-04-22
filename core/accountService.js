const fs = require('fs');
const path = require('path');

const controlPlane = require('./controlPlane');
const deviceState = require('./deviceState');
const { writeJsonAtomicSync } = require('./fsAtomic');

function authHeaders() {
  const s = deviceState.readDeviceState();
  if (!s.token) throw new Error('设备未激活');
  return { Authorization: `Bearer ${s.token}` };
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
  return { machineId, serverUrl: base };
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
  listAllowedProfiles,
  downloadProfileStorageState,
  fullSyncToDir,
};
