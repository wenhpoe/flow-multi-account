const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomicSync } = require('./fsAtomic');

function isElectronRuntime() {
  return Boolean(process.versions && process.versions.electron);
}

function getUserDataDir() {
  if (!isElectronRuntime()) return null;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch {
    // ignore
  }
  return null;
}

function getDeviceFilePath() {
  const dir = getUserDataDir();
  if (!dir) return null;
  return path.join(dir, 'device.json');
}

function defaultBaseUrl() {
  return process.env.PROXY_SERVICE_URL || 'http://127.0.0.1:3123';
}

function normalizeUrl(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (!s) return 'http://127.0.0.1:3123';

  // If user enters "host:port" without scheme, default to http://
  // Examples: "192.168.1.10:3123" / "localhost:3123"
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, '');
}

function readDeviceState() {
  const fp = getDeviceFilePath();
  const base = { machineId: null, token: null, serverUrl: normalizeUrl(defaultBaseUrl()), allowedProfiles: [] };
  if (!fp) return base;

  try {
    if (!fs.existsSync(fp)) {
      const machineId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      const init = { ...base, machineId };
      writeJsonAtomicSync(fp, init);
      return init;
    }
    const raw = fs.readFileSync(fp, 'utf8');
    const data = JSON.parse(raw);
    const machineId = String(data?.machineId || '').trim() || null;
    const token = String(data?.token || '').trim() || null;
    const serverUrl = normalizeUrl(data?.serverUrl || defaultBaseUrl());
    const allowedProfiles = Array.isArray(data?.allowedProfiles)
      ? data.allowedProfiles.map((s) => String(s).trim()).filter(Boolean)
      : [];
    return { machineId, token, serverUrl, allowedProfiles };
  } catch {
    // If corrupted, reset while preserving a stable machineId if possible.
    const machineId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const init = { ...base, machineId };
    try {
      writeJsonAtomicSync(fp, init);
    } catch {
      // ignore
    }
    return init;
  }
}

function writeDeviceState(patch) {
  const fp = getDeviceFilePath();
  if (!fp) return readDeviceState();
  const cur = readDeviceState();
  const next = { ...cur, ...patch };
  if (next.serverUrl) next.serverUrl = normalizeUrl(next.serverUrl);
  if (next.allowedProfiles && Array.isArray(next.allowedProfiles)) {
    next.allowedProfiles = next.allowedProfiles.map((s) => String(s).trim()).filter(Boolean);
  }
  writeJsonAtomicSync(fp, next);
  return next;
}

function isActivated() {
  const s = readDeviceState();
  return Boolean(s.machineId && s.token);
}

module.exports = {
  readDeviceState,
  writeDeviceState,
  isActivated,
  normalizeUrl,
};
