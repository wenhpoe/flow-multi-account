const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('./fsAtomic');

function isElectronRuntime() {
  return Boolean(process.versions && process.versions.electron);
}

function getSettingsFilePath() {
  if (!isElectronRuntime()) return null;
  if (process.env.FLOW_SWITCHER_SETTINGS_FILE) return process.env.FLOW_SWITCHER_SETTINGS_FILE;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'settings.json');
    }
  } catch {
    // ignore
  }
  return null;
}

function readSettings() {
  const file = getSettingsFilePath();
  if (!file) return {};
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function replaceSettings(next) {
  const file = getSettingsFilePath();
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomicSync(file, next && typeof next === 'object' ? next : {});
    return true;
  } catch {
    return false;
  }
}

function writeSettings(patch) {
  const current = readSettings();
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
  replaceSettings(next);
  return next;
}

module.exports = {
  isElectronRuntime,
  getSettingsFilePath,
  readSettings,
  replaceSettings,
  writeSettings
};
