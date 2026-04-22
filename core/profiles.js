const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('./fsAtomic');

function isNoLocalProfiles() {
  const raw = String(process.env.FMA_NO_LOCAL_PROFILES || '').trim().toLowerCase();
  // Default: enabled in Electron runtime (safer by default). Can be disabled explicitly.
  if (!raw) return isElectronRuntime();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'n') return false;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

function isElectronRuntime() {
  return Boolean(process.versions && process.versions.electron);
}

function getDataDir() {
  if (process.env.FLOW_SWITCHER_DATA_DIR) return process.env.FLOW_SWITCHER_DATA_DIR;

  if (isElectronRuntime()) {
    try {
      // Only works in Electron main/preload. In renderer we use IPC.
      const { app } = require('electron');
      if (app && typeof app.getPath === 'function') {
        // `userData` is already app-scoped:
        // - Windows: %APPDATA%/<appName>
        // - macOS: ~/Library/Application Support/<appName>
        // - Linux: ~/.config/<appName>
        return app.getPath('userData');
      }
    } catch {
      // ignore
    }
  }

  // Dev / web-server mode fallback: keep existing local folder.
  return path.join(__dirname, '..', 'profiles');
}

function getProfilesDir() {
  return path.join(getDataDir(), 'profiles');
}

function migrateLegacyProfilesDir() {
  if (isNoLocalProfiles()) return;
  if (!isElectronRuntime()) return;
  if (process.env.FLOW_SWITCHER_DATA_DIR) return;

  let userDataDir;
  try {
    const { app } = require('electron');
    userDataDir = app.getPath('userData');
  } catch {
    return;
  }

  const legacyDir = path.join(userDataDir, 'flow-multi-account', 'profiles');
  const newDir = path.join(userDataDir, 'profiles');
  if (!fs.existsSync(legacyDir)) return;

  // If the new dir doesn't exist yet, prefer a fast move.
  if (!fs.existsSync(newDir)) {
    try {
      fs.renameSync(legacyDir, newDir);
      return;
    } catch {
      // fall back to copy below
    }
  }

  // Merge legacy -> new, without overwriting.
  try {
    fs.mkdirSync(newDir, { recursive: true });
    const legacyFiles = fs.readdirSync(legacyDir).filter((f) => f.toLowerCase().endsWith('.json'));
    for (const file of legacyFiles) {
      const src = path.join(legacyDir, file);
      const dst = path.join(newDir, file);
      if (fs.existsSync(dst)) continue;
      try {
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      } catch {
        // ignore individual failures
      }
    }
  } catch {
    // ignore
  }
}

function ensureProfilesDir() {
  if (isNoLocalProfiles()) throw new Error('已开启无落盘模式：本机不保存账号文件（profiles）');
  migrateLegacyProfilesDir();
  const dir = getProfilesDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeProfileName(name) {
  const cleaned = String(name || '').trim();
  if (!cleaned) throw new Error('账号名称不能为空');
  if (cleaned.length > 80) throw new Error('账号名称过长');
  if (cleaned.includes('/') || cleaned.includes('\\')) throw new Error('账号名称不能包含路径分隔符');
  if (cleaned.includes('..')) throw new Error('账号名称非法');
  return cleaned;
}

function purgeProfilesDir() {
  const dir = getProfilesDir();
  if (!fs.existsSync(dir)) return { removed: 0, dir };
  let removed = 0;
  try {
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(dir, f));
        removed += 1;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return { removed, dir };
}

function profileFilePath(profileName) {
  const safeName = sanitizeProfileName(profileName);
  const dir = ensureProfilesDir();
  const filePath = path.join(dir, `${safeName}.json`);
  const resolvedDir = path.resolve(dir) + path.sep;
  const resolvedFilePath = path.resolve(filePath);
  if (!resolvedFilePath.startsWith(resolvedDir)) throw new Error('账号名称非法');
  return resolvedFilePath;
}

function listProfiles() {
  if (isNoLocalProfiles()) return [];
  const dir = ensureProfilesDir();
  return fs
    .readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .map((file) => file.replace(/\.json$/i, ''))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function readStorageState(profileName) {
  if (isNoLocalProfiles()) {
    throw new Error('已开启无落盘模式：本机不保存账号文件，请在“已激活模式”下从管理端拉取并内存使用');
  }
  const filePath = profileFilePath(profileName);
  if (!fs.existsSync(filePath)) throw new Error('账号不存在');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeStorageState(profileName, storageState) {
  if (isNoLocalProfiles()) {
    throw new Error('已开启无落盘模式：不会将账号登录态保存到本机（profiles）');
  }
  const safeName = sanitizeProfileName(profileName);
  const filePath = profileFilePath(safeName);
  writeJsonAtomicSync(filePath, storageState);
  return safeName;
}

function deleteProfile(profileName) {
  if (isNoLocalProfiles()) {
    throw new Error('已开启无落盘模式：本机不保存账号文件，无需删除');
  }
  const filePath = profileFilePath(profileName);
  if (!fs.existsSync(filePath)) throw new Error('账号不存在');
  fs.unlinkSync(filePath);
}

module.exports = {
  getProfilesDir,
  isNoLocalProfiles,
  purgeProfilesDir,
  sanitizeProfileName,
  listProfiles,
  readStorageState,
  writeStorageState,
  deleteProfile
};
