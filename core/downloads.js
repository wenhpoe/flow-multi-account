const fs = require('fs');
const path = require('path');

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

function writeSettings(patch) {
  const file = getSettingsFilePath();
  if (!file) return false;
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const current = readSettings();
    const next = { ...current, ...patch };
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    return true;
  } catch {
    return false;
  }
}

function setDownloadsDir(dirPath) {
  const cleaned = String(dirPath || '').trim();
  if (!cleaned) throw new Error('下载目录不能为空');
  fs.mkdirSync(cleaned, { recursive: true });
  if (!writeSettings({ downloadsDir: cleaned })) {
    throw new Error('保存下载目录失败');
  }
  return cleaned;
}

function clearDownloadsDir() {
  // Reset to default behavior by removing setting.
  if (!isElectronRuntime()) return false;
  const current = readSettings();
  if (!('downloadsDir' in current)) return true;
  const next = { ...current };
  delete next.downloadsDir;
  const file = getSettingsFilePath();
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    return true;
  } catch {
    return false;
  }
}

function getDownloadsDir() {
  if (process.env.FLOW_SWITCHER_DOWNLOADS_DIR) return process.env.FLOW_SWITCHER_DOWNLOADS_DIR;

  if (isElectronRuntime()) {
    try {
      const { app } = require('electron');
      if (app && typeof app.getPath === 'function') {
        const settings = readSettings();
        if (settings.downloadsDir && typeof settings.downloadsDir === 'string') {
          return settings.downloadsDir;
        }
        // Keep a dedicated folder under the system Downloads for visibility.
        return path.join(app.getPath('downloads'), 'Flow 多账号管理器');
      }
    } catch {
      // ignore
    }
  }

  // Dev / web-server mode fallback.
  return path.join(__dirname, '..', 'downloads');
}

function ensureDownloadsDir() {
  const dir = getDownloadsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || '').trim() || 'download');
  // Windows-invalid: <>:"/\|?* plus control chars
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'download';
}

function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  let out = path.join(dir, filename);
  let i = 1;
  while (fs.existsSync(out)) {
    out = path.join(dir, `${stem} (${i})${ext}`);
    i += 1;
  }
  return out;
}

function attachAutoSaveToPage(page) {
  if (!page || typeof page.on !== 'function') return;
  if (page.__flowDownloadsHooked) return;
  page.__flowDownloadsHooked = true;

  page.on('download', async (download) => {
    try {
      const dir = ensureDownloadsDir();
      const suggested = sanitizeFilename(download.suggestedFilename());
      const dst = uniquePath(dir, suggested);
      await download.saveAs(dst);
      console.log(`⬇️ 已保存下载：${dst}`);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.warn(`⚠️ 下载保存失败：${msg}`);
    }
  });
}

function hookContext(context) {
  if (!context || typeof context.on !== 'function') return;
  if (context.__flowDownloadsHooked) return;
  context.__flowDownloadsHooked = true;

  // Ensure the downloads directory exists early.
  try {
    ensureDownloadsDir();
  } catch {
    // ignore
  }

  context.on('page', (page) => attachAutoSaveToPage(page));
}

module.exports = {
  getDownloadsDir,
  ensureDownloadsDir,
  setDownloadsDir,
  clearDownloadsDir,
  hookContext,
  attachAutoSaveToPage
};
