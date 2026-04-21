const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const profiles = require('../core/profiles');
const flowWindow = require('../core/flowWindow');
const profileCapture = require('../core/profileCapture');
const downloads = require('../core/downloads');
const deviceState = require('../core/deviceState');
const accountService = require('../core/accountService');
const singBox = require('../core/singBoxManager');

const APP_NAME = 'Flow 多账号管理器';
const APP_ID = 'com.internal.flow-multi-account';
const ICON_PNG = path.join(__dirname, '..', 'build', 'icon.png');
const ICON_ICO = path.join(__dirname, '..', 'build', 'icon.ico');
const ICON_PATH = process.platform === 'win32' ? ICON_ICO : ICON_PNG;

// Improve taskbar/dock identity (especially on Windows).
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

let autoUpdateCtl = null;
let autoUpdateState = { state: 'idle', updatedAt: null, logPath: null };

function setupAutoUpdate(mainWindow) {
  if (!app.isPackaged) return;
  if (process.env.FMA_AUTO_UPDATE === '0') return;

  let autoUpdater;
  try {
    // eslint-disable-next-line global-require
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.warn(`⚠️ 自动更新组件不可用：${e?.message || e}`);
    return;
  }

  autoUpdater.autoDownload = true;

  const logPath = (() => {
    try {
      return path.join(app.getPath('userData'), 'auto-update.log');
    } catch {
      return null;
    }
  })();

  autoUpdateState = { state: 'idle', updatedAt: null, logPath };

  const log = (line) => {
    const msg = `[${new Date().toISOString()}] ${String(line || '').trim()}\n`;
    try {
      if (logPath) fs.appendFileSync(logPath, msg, 'utf8');
    } catch {
      // ignore
    }
  };

  const sendStatus = (status) => {
    try {
      autoUpdateState = { ...autoUpdateState, ...status, updatedAt: new Date().toISOString() };
    } catch {
      // ignore
    }
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:updateStatus', status);
      }
    } catch {
      // ignore
    }
  };

  let hasShownAvailable = false;
  let hasShownError = false;
  let lastProgressPct = null;

  autoUpdater.on('checking-for-update', () => {
    log('checking-for-update');
    sendStatus({ state: 'checking' });
  });
  autoUpdater.on('update-available', async (info) => {
    const v = info?.version || null;
    log(`update-available version=${v || ''}`);
    sendStatus({ state: 'available', version: v, releaseName: info?.releaseName || null });

    if (hasShownAvailable) return;
    hasShownAvailable = true;
    try {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '发现新版本',
        message: `发现新版本 ${v || ''}，正在后台下载…`,
        buttons: ['知道了'],
        defaultId: 0,
        noLink: true,
      });
    } catch {
      // ignore
    }
  });
  autoUpdater.on('update-not-available', (info) => {
    const v = info?.version || null;
    log(`update-not-available version=${v || ''}`);
    sendStatus({ state: 'none' });
  });
  autoUpdater.on('download-progress', (p) => {
    const pct = typeof p?.percent === 'number' ? Math.max(0, Math.min(100, Math.floor(p.percent))) : null;
    if (pct != null && pct !== lastProgressPct) {
      lastProgressPct = pct;
      log(`download-progress ${pct}%`);
    }
    sendStatus({ state: 'downloading', percent: p?.percent ?? null, bytesPerSecond: p?.bytesPerSecond ?? null });
  });
  autoUpdater.on('error', async (err) => {
    const msg = err?.message || String(err);
    log(`error ${msg}`);
    sendStatus({ state: 'error', error: msg });

    if (hasShownError) return;
    hasShownError = true;
    try {
      dialog.showErrorBox(
        '自动更新失败',
        `自动更新检查/下载失败。\n\n错误信息：${msg}\n\n排查建议：\n- 确认 GitHub Release 不是 Draft/Pre-release\n- 确认 Release 里有 latest.yml（Windows）或 latest-mac.yml + .zip（macOS）\n- macOS 请确保应用已安装到“应用程序”目录后再启动\n\n日志：${logPath || '（不可用）'}`,
      );
    } catch {
      // ignore
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    log(`update-downloaded version=${info?.version || ''}`);
    sendStatus({ state: 'downloaded', version: info?.version || null });
    try {
      const r = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '发现新版本',
        message: `已下载新版本 ${info?.version || ''}，是否立即重启更新？`,
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (r.response === 0) {
        try {
          autoUpdater.quitAndInstall();
        } catch (e) {
          dialog.showErrorBox('重启更新失败', String(e?.message || e));
        }
      }
    } catch {
      // ignore
    }
  });

  autoUpdater.checkForUpdates().catch((e) => {
    log(`checkForUpdates failed: ${e?.message || e}`);
    console.warn(`⚠️ 自动更新检查失败：${e?.message || e}`);
  });

  autoUpdateCtl = {
    check: async ({ allowPrerelease = false } = {}) => {
      try {
        autoUpdater.allowPrerelease = allowPrerelease === true;
      } catch {
        // ignore
      }
      await autoUpdater.checkForUpdates();
      return { ok: true };
    },
    install: async () => {
      try {
        autoUpdater.quitAndInstall();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
    openLog: async () => {
      if (!logPath) return { ok: false, error: 'log path unavailable' };
      await shell.openPath(logPath);
      return { ok: true, logPath };
    },
    state: () => autoUpdateState
  };
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#f3f6ef',
    show: false,
    autoHideMenuBar: true,
    title: APP_NAME,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: process.env.FMA_DEVTOOLS === '1'
    }
  });

  win.once('ready-to-show', () => win.show());

  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  win.loadFile(indexPath);

  return win;
}

ipcMain.handle('profiles:list', async () => {
  if (profiles.isNoLocalProfiles()) {
    if (!deviceState.isActivated()) return [];
    try {
      const { profiles: allowedProfiles } = await accountService.listAllowedProfiles();
      const names = allowedProfiles.map((p) => p.name);
      try {
        deviceState.writeDeviceState({ allowedProfiles: names });
      } catch {
        // ignore
      }
      return names;
    } catch {
      const s = deviceState.readDeviceState();
      const allowed = Array.isArray(s.allowedProfiles) ? s.allowedProfiles : [];
      return allowed;
    }
  }

  const list = profiles.listProfiles();
  if (!deviceState.isActivated()) return list;
  const s = deviceState.readDeviceState();
  const allowed = Array.isArray(s.allowedProfiles) ? s.allowedProfiles : [];
  if (!allowed.length) return [];
  const allowedSet = new Set(allowed);
  return list.filter((n) => allowedSet.has(n));
});
ipcMain.handle('profiles:delete', async (_evt, name) => {
  if (deviceState.isActivated()) throw new Error('已激活模式下不允许本地删除账号（请联系管理员变更分配并重新同步）');
  profiles.deleteProfile(name);
  return { success: true };
});
ipcMain.handle('profiles:import', async () => {
  if (deviceState.isActivated()) return { success: false, error: '已激活模式下不允许导入本地 JSON（请使用“同步账号”）' };
  const result = await dialog.showOpenDialog({
    title: '选择包含账号 JSON 的文件夹（profiles）',
    properties: ['openDirectory']
  });

  if (result.canceled || !result.filePaths || !result.filePaths[0]) {
    return { success: true, imported: 0, skipped: 0, details: [] };
  }

  const srcDir = result.filePaths[0];
  const dstDir = profiles.getProfilesDir();
  if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });

  const files = fs.readdirSync(srcDir).filter((f) => f.toLowerCase().endsWith('.json'));
  let imported = 0;
  let skipped = 0;
  const details = [];

  for (const file of files) {
    const src = path.join(srcDir, file);
    const name = file.replace(/\.json$/i, '');
    let dst;
    try {
      dst = path.join(dstDir, `${profiles.sanitizeProfileName(name)}.json`);
    } catch {
      skipped += 1;
      details.push({ file, status: 'skipped', reason: 'illegal-name' });
      continue;
    }

    if (fs.existsSync(dst)) {
      skipped += 1;
      details.push({ file, status: 'skipped', reason: 'exists' });
      continue;
    }

    try {
      // quick validation: must be JSON
      JSON.parse(fs.readFileSync(src, 'utf8'));
      fs.copyFileSync(src, dst);
      imported += 1;
      details.push({ file, status: 'imported' });
    } catch {
      skipped += 1;
      details.push({ file, status: 'skipped', reason: 'invalid-json' });
    }
  }

  return { success: true, imported, skipped, details, dstDir };
});

ipcMain.handle('profiles:export', async (_evt, payload) => {
  if (deviceState.isActivated()) return { success: false, error: '已激活模式下不允许导出（由管理员统一管理）' };
  const requestedNames = Array.isArray(payload?.names)
    ? payload.names.map((n) => String(n)).filter(Boolean)
    : null;

  const result = await dialog.showOpenDialog({
    title: '选择导出目录（将创建一个新文件夹）',
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths || !result.filePaths[0]) {
    return { success: true, exported: 0, dstDir: null };
  }

  const baseDir = result.filePaths[0];
  const srcDir = profiles.getProfilesDir();
  if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });

  const pad2 = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(
    d.getMinutes()
  )}${pad2(d.getSeconds())}`;
  const dstDir = path.join(baseDir, `flow-profiles-export-${stamp}`);
  fs.mkdirSync(dstDir, { recursive: true });

  const availableFiles = new Set(
    fs
      .readdirSync(srcDir)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => f)
  );

  const files = requestedNames
    ? requestedNames
        .map((name) => {
          try {
            return `${profiles.sanitizeProfileName(name)}.json`;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter((file) => availableFiles.has(file))
    : Array.from(availableFiles);

  let skipped = 0;
  let invalid = 0;
  let missing = 0;
  if (requestedNames) {
    for (const name of requestedNames) {
      try {
        const file = `${profiles.sanitizeProfileName(name)}.json`;
        if (!availableFiles.has(file)) missing += 1;
      } catch {
        invalid += 1;
      }
    }
  }

  let exported = 0;
  for (const file of files) {
    const src = path.join(srcDir, file);
    const dst = path.join(dstDir, file);
    try {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      exported += 1;
    } catch {
      skipped += 1;
    }
  }

  return {
    success: true,
    exported,
    skipped,
    invalid,
    missing,
    dstDir
  };
});

ipcMain.handle('flow:open', async (_evt, name) => {
  if (deviceState.isActivated()) {
    const s = deviceState.readDeviceState();
    const allowed = Array.isArray(s.allowedProfiles) ? s.allowedProfiles : [];
    if (!allowed.includes(String(name))) throw new Error('该账号未分配给本机器（请联系管理员）');
  }
  const result = await flowWindow.openFlowWithProfile(name);
  return { success: true, ...result };
});
ipcMain.handle('flow:close', async () => {
  await flowWindow.closeAllFlowWindows();
  return { success: true };
});
ipcMain.handle('flow:closeSession', async (_evt, sessionId) => {
  const result = await flowWindow.closeFlowSession(sessionId);
  return { success: true, ...result };
});
ipcMain.handle('flow:focusSession', async (_evt, sessionId) => {
  const result = await flowWindow.focusFlowSession(sessionId);
  return { success: true, ...result };
});
ipcMain.handle('flow:quit', async () => {
  await flowWindow.quitBrowser();
  return { success: true };
});

ipcMain.handle('capture:start', async (_evt, name) => {
  if (profiles.isNoLocalProfiles()) {
    throw new Error('已开启无落盘模式：本机不保存账号登录态（请联系管理员在管理端保存/分配账号）');
  }
  if (deviceState.isActivated()) throw new Error('已激活模式下不允许在本机新增账号（由管理员统一分配）');
  const result = await profileCapture.startCapture(name);
  return { success: true, ...result };
});
ipcMain.handle('capture:finish', async () => {
  const result = await profileCapture.finishCapture();
  return { success: true, ...result };
});
ipcMain.handle('capture:cancel', async () => {
  await profileCapture.cancelCapture();
  return { success: true };
});

ipcMain.handle('app:status', async () => ({
  appVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  platform: process.platform,
  update: autoUpdateCtl ? autoUpdateCtl.state() : autoUpdateState,
  flow: flowWindow.getFlowState({
    includeProxyDebug: process.env.FMA_PROXY_LOG_CREDENTIALS === '1' || process.env.FMA_PROXY_DEBUG === '1'
  }),
  capture: profileCapture.getCaptureState(),
  profilesDir: profiles.getProfilesDir(),
  noLocalProfiles: profiles.isNoLocalProfiles(),
  downloadsDir: downloads.getDownloadsDir(),
  singBox: singBox.getPluginStatus(),
  device: {
    ...deviceState.readDeviceState(),
    activated: deviceState.isActivated()
  }
}));

ipcMain.handle('update:check', async (_evt, opts) => {
  if (!autoUpdateCtl) return { ok: false, error: 'auto update not available' };
  try {
    return await autoUpdateCtl.check(opts && typeof opts === 'object' ? opts : {});
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});
ipcMain.handle('update:install', async () => {
  if (!autoUpdateCtl) return { ok: false, error: 'auto update not available' };
  return autoUpdateCtl.install();
});
ipcMain.handle('update:openLog', async () => {
  if (!autoUpdateCtl) return { ok: false, error: 'auto update not available' };
  try {
    return await autoUpdateCtl.openLog();
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('app:openProfilesFolder', async () => {
  const dir = profiles.getProfilesDir();
  await shell.openPath(dir);
  return { success: true };
});

ipcMain.handle('app:openDownloadsFolder', async () => {
  const dir = downloads.getDownloadsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  await shell.openPath(dir);
  return { success: true };
});

ipcMain.handle('device:activate', async (_evt, payload) => {
  const s = deviceState.readDeviceState();
  const activationCode = String(payload?.activationCode || '').trim();
  const serverUrl = String(payload?.serverUrl || s.serverUrl || '').trim();
  if (!s.machineId) throw new Error('无法生成机器码');
  if (!activationCode) throw new Error('请输入激活码');
  if (!serverUrl) throw new Error('请输入服务地址');

  try {
    await accountService.activateDevice({ machineId: s.machineId, activationCode, serverUrl });
  } catch (e) {
    const msg = e && typeof e === 'object' && e.message ? String(e.message) : '激活失败';
    throw new Error(msg);
  }
  return { success: true, device: { ...deviceState.readDeviceState(), activated: true } };
});

function normalizeAndValidateServerUrl(input) {
  const base = deviceState.normalizeUrl(input);
  let u;
  try {
    u = new URL(base);
  } catch {
    throw new Error('服务地址格式不正确：请填写类似 http://192.168.1.10:3123');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('服务地址协议不支持：仅支持 http/https');
  if (u.hostname === '0.0.0.0') {
    throw new Error('服务地址不能使用 0.0.0.0：请改用管理员电脑的局域网 IP 或 127.0.0.1');
  }
  return base;
}

ipcMain.handle('device:setServerUrl', async (_evt, payload) => {
  const serverUrlRaw = String(payload?.serverUrl || '').trim();
  if (!serverUrlRaw) throw new Error('请输入服务地址');
  const base = normalizeAndValidateServerUrl(serverUrlRaw);
  const next = deviceState.writeDeviceState({ serverUrl: base });
  return { success: true, device: { ...next, activated: deviceState.isActivated() } };
});

ipcMain.handle('device:sync', async () => {
  const s = deviceState.readDeviceState();
  if (!s.token) throw new Error('设备未激活');
  if (profiles.isNoLocalProfiles()) {
    const { profiles: allowedProfiles } = await accountService.listAllowedProfiles();
    const names = allowedProfiles.map((p) => p.name);
    deviceState.writeDeviceState({ allowedProfiles: names });
    // Best-effort: purge any existing local storageState json files.
    const purged = profiles.purgeProfilesDir();
    return { success: true, downloaded: 0, removed: purged.removed, allowedProfiles: names, mode: 'no-local' };
  }

  const result = await accountService.fullSyncToDir(profiles.getProfilesDir(), { removeExtra: true });
  return { success: true, ...result };
});

ipcMain.handle('app:chooseDownloadsFolder', async () => {
  const current = downloads.getDownloadsDir();
  const result = await dialog.showOpenDialog({
    title: '选择下载保存目录',
    defaultPath: current,
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths || !result.filePaths[0]) {
    return { success: true, canceled: true, downloadsDir: current };
  }

  const chosen = result.filePaths[0];
  const newDir = downloads.setDownloadsDir(chosen);
  return { success: true, downloadsDir: newDir };
});

ipcMain.handle('app:resetDownloadsFolder', async () => {
  downloads.clearDownloadsDir();
  return { success: true, downloadsDir: downloads.getDownloadsDir() };
});

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    try {
      app.dock.setIcon(ICON_PNG);
    } catch {
      // ignore
    }
  }

  // Optional hardening: avoid keeping storageState JSON on disk.
  if (profiles.isNoLocalProfiles()) {
    try {
      const r = profiles.purgeProfilesDir();
      if (r.removed) {
        console.log(`🧹 已清理本机账号文件：${r.removed} 个（无落盘模式）`);
      }
    } catch {
      // ignore
    }
  }

  // Preload sing-box on startup (best-effort) so the first node-use won’t block on download.
  // Can be disabled with FMA_SINGBOX_AUTO_DOWNLOAD=0.
  try {
    singBox
      .preload()
      .then((r) => {
        if (r && r.ok && r.source === 'download') {
          console.log(`✅ sing-box 已自动下载：${r.bin}`);
        }
      })
      .catch((e) => {
        // Keep silent by default: node proxies will surface errors when actually used.
        if (process.env.FMA_SINGBOX_DEBUG === '1') {
          console.warn(`⚠️ sing-box 预加载失败：${e?.message || e}`);
        }
      });
  } catch {
    // ignore
  }

  const win = createMainWindow();
  setupAutoUpdate(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try {
    // Best-effort: kill local sing-box (if started) so it won’t linger after app exit.
    singBox.stop().catch(() => {});
  } catch {
    // ignore
  }

  if (profiles.isNoLocalProfiles()) {
    try {
      profiles.purgeProfilesDir();
    } catch {
      // ignore
    }
  }
});
