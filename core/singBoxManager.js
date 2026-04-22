const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { writeJsonAtomicSync } = require('./fsAtomic');

let pluginStatus = {
  state: 'unknown', // unknown | checking | missing | downloading | ready | error
  bin: null,
  message: null,
  url: null,
  updatedAt: null,
};

function setPluginStatus(patch) {
  let updatedAt = null;
  try {
    // eslint-disable-next-line global-require
    const time = require('./time');
    updatedAt = time.nowIso();
  } catch {
    updatedAt = new Date().toISOString();
  }
  pluginStatus = {
    ...pluginStatus,
    ...(patch || {}),
    updatedAt,
  };
}

function getPluginStatus() {
  return { ...pluginStatus };
}

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

function runtimeDir() {
  const base = getUserDataDir();
  if (base) return path.join(base, 'runtime');
  return path.join(os.tmpdir(), 'flow-multi-account-runtime');
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parsePort(v, fallback) {
  const n = v != null ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const p = Math.floor(n);
  if (p <= 0 || p > 65535) return fallback;
  return p;
}

function localListenHost() {
  const h = String(process.env.FMA_SINGBOX_LISTEN || '').trim();
  return h || '127.0.0.1';
}

function localListenPort() {
  return parsePort(process.env.FMA_SINGBOX_PORT, 53182);
}

function startTimeoutMs() {
  return parsePort(process.env.FMA_SINGBOX_START_TIMEOUT_MS, 8000);
}

function stopTimeoutMs() {
  return parsePort(process.env.FMA_SINGBOX_STOP_TIMEOUT_MS, 1500);
}

function resolveSingBoxBin() {
  const raw = String(process.env.FMA_SINGBOX_BIN || '').trim();
  if (raw) return raw;

  const binName = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  const candidates = findBundledSingBoxCandidates(binName);
  for (const p of candidates) {
    if (isUsableFile(p)) return p;
  }

  // Fall back to PATH.
  return binName;
}

function isUsableFile(filePath) {
  const fp = String(filePath || '').trim();
  if (!fp) return false;
  try {
    if (!fs.existsSync(fp)) return false;
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    fs.accessSync(fp, fs.constants.X_OK);
    return true;
  } catch {
    return true; // best-effort: may still be runnable depending on FS perms
  }
}

function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const it of list || []) {
    const s = String(it || '').trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function findBundledSingBoxCandidates(binName) {
  const name = String(binName || '').trim();
  if (!name) return [];

  const variants = [name, path.join(process.platform, name), path.join(`${process.platform}-${process.arch}`, name)];

  const bases = [];
  // Auto-downloaded install location (writable): <userData>/runtime/sing-box/
  try {
    bases.push(path.join(runtimeDir(), 'sing-box'));
  } catch {
    // ignore
  }
  // Dev: ./bin under app cwd (when running `npm start` inside flow-multi-account/).
  try {
    bases.push(path.join(process.cwd(), 'bin'));
  } catch {
    // ignore
  }
  // Dev: relative to this file.
  bases.push(path.join(__dirname, '..', 'bin'));

  // Packaged app: binaries must be outside asar (asarUnpack places them under app.asar.unpacked).
  if (isElectronRuntime()) {
    try {
      const resources = process.resourcesPath;
      if (resources) {
        bases.push(path.join(resources, 'app.asar.unpacked', 'bin'));
        bases.push(path.join(resources, 'bin'));
      }
    } catch {
      // ignore
    }
  }

  // Common install locations (macOS/Homebrew).
  if (process.platform === 'darwin') {
    bases.push('/opt/homebrew/bin');
    bases.push('/usr/local/bin');
  }
  // Common install locations (Linux).
  if (process.platform === 'linux') {
    bases.push('/usr/local/bin');
    bases.push('/usr/bin');
  }

  const out = [];
  for (const base of bases) {
    for (const v of variants) {
      out.push(path.join(base, v));
    }
  }
  return uniq(out);
}

function formatSingBoxNotFoundMessage(triedBin) {
  const binName = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  const candidates = findBundledSingBoxCandidates(binName);
  const tried = String(triedBin || '').trim() || binName;
  const hint =
    process.platform === 'darwin'
      ? 'macOS: `brew install sing-box` 或把二进制放到 `flow-multi-account/bin/`（可用 FMA_SINGBOX_BIN 指定路径）。'
      : process.platform === 'win32'
        ? 'Windows: 下载 `sing-box.exe` 放到 `flow-multi-account/bin/` 或设置 `FMA_SINGBOX_BIN=C:\\\\path\\\\to\\\\sing-box.exe`。'
        : '安装 sing-box 并确保在 PATH 中，或设置 FMA_SINGBOX_BIN=/path/to/sing-box。';
  const sample = candidates.slice(0, 6);
  const more = candidates.length > sample.length ? ` …(+${candidates.length - sample.length})` : '';
  const autoEnabled = isAutoDownloadEnabled();
  const autoHint = autoEnabled
    ? '（自动下载已启用；如下载失败可设置 FMA_SINGBOX_DOWNLOAD_URL 或关闭 FMA_SINGBOX_AUTO_DOWNLOAD=0）'
    : '也可开启自动下载：设置 FMA_SINGBOX_AUTO_DOWNLOAD=1（可选：FMA_SINGBOX_DOWNLOAD_URL / FMA_SINGBOX_VERSION）。';
  return `未找到 sing-box 可执行文件（尝试：${tried}）。${hint} ${autoHint} 候选路径：${sample.join(' , ')}${more}`;
}

function singBoxBinName() {
  return process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
}

function isAutoDownloadEnabled() {
  const raw = String(process.env.FMA_SINGBOX_AUTO_DOWNLOAD || '').trim().toLowerCase();
  // Default: enabled in Electron runtime to reduce setup friction.
  if (!raw) return isElectronRuntime();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'n') return false;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

function downloadTimeoutMs() {
  const raw = process.env.FMA_SINGBOX_DOWNLOAD_TIMEOUT_MS;
  const n = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 60000;
  return Math.min(10 * 60 * 1000, Math.max(3000, Math.floor(n)));
}

function urlBasename(u) {
  try {
    const url = typeof u === 'string' ? new URL(u) : u;
    const p = String(url.pathname || '');
    const base = p.split('/').filter(Boolean).pop() || '';
    return base || '';
  } catch {
    return '';
  }
}

function withTimeoutPromise(promise, timeoutMs, label) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`timeout ${ms}ms${label ? ` (${label})` : ''}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function downloadToFile(urlRaw, filePath, { timeoutMs } = {}) {
  const maxRedirects = 6;
  const ms = timeoutMs != null ? Number(timeoutMs) : downloadTimeoutMs();

  return withTimeoutPromise(
    (async () => {
      ensureDir(path.dirname(filePath));

      let current = String(urlRaw || '').trim();
      if (!current) throw new Error('download url required');

      for (let i = 0; i <= maxRedirects; i += 1) {
        let u;
        try {
          u = new URL(current);
        } catch {
          throw new Error('invalid download url');
        }

        const mod = u.protocol === 'http:' ? http : u.protocol === 'https:' ? https : null;
        if (!mod) throw new Error(`unsupported url protocol: ${u.protocol}`);

        const res = await new Promise((resolve, reject) => {
          const req = mod.request(
            u,
            {
              method: 'GET',
              headers: {
                'user-agent': 'flow-multi-account',
                accept: '*/*',
              },
            },
            (r) => resolve(r),
          );
          req.once('error', (e) => reject(e));
          req.end();
        });

        const code = Number(res.statusCode) || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          const next = new URL(String(res.headers.location), u).toString();
          res.resume();
          current = next;
          continue;
        }

        if (code < 200 || code >= 300) {
          const chunks = [];
          let total = 0;
          for await (const c of res) {
            chunks.push(c);
            total += c.length || 0;
            if (total > 2048) break;
          }
          const sample = Buffer.concat(chunks).toString('utf8').slice(0, 800);
          throw new Error(`download failed: HTTP ${code}${sample ? ` (${sample})` : ''}`);
        }

        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(filePath);
          let done = false;
          const finish = (err) => {
            if (done) return;
            done = true;
            try {
              file.close(() => {});
            } catch {
              // ignore
            }
            if (err) reject(err);
            else resolve(true);
          };
          res.once('error', (e) => finish(e || new Error('download stream error')));
          file.once('error', (e) => finish(e || new Error('write error')));
          file.once('finish', () => finish(null));
          res.pipe(file);
        });

        return filePath;
      }

      throw new Error('download failed: too many redirects');
    })(),
    ms,
    'download',
  );
}

function isPathLike(bin) {
  const s = String(bin || '').trim();
  if (!s) return false;
  if (path.isAbsolute(s)) return true;
  return s.includes('/') || s.includes('\\');
}

function probeBinary(binPath, { args = ['version'], timeoutMs = 2500 } = {}) {
  return withTimeoutPromise(
    new Promise((resolve, reject) => {
      const proc = spawn(binPath, args, {
        stdio: 'ignore',
        windowsHide: true,
      });
      proc.once('error', (e) => reject(e || new Error('spawn error')));
      proc.once('exit', (code) => {
        // Even if exit code is non-zero, ENOENT would have surfaced via 'error'.
        resolve({ ok: code === 0, code });
      });
    }),
    timeoutMs,
    'probe',
  );
}

async function fetchGithubReleaseInfo({ version } = {}) {
  const apiBase = String(process.env.FMA_SINGBOX_GITHUB_API_BASE || '').trim() || 'https://api.github.com';
  const v = String(version || '').trim();

  async function fetchOnce(url) {
    // Use built-in fetch when available (Node 18+ / Electron).
    if (typeof fetch !== 'function') throw new Error('fetch not available');
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'user-agent': 'flow-multi-account',
        accept: 'application/vnd.github+json',
      },
    });
    if (!r.ok) throw new Error(`github api http ${r.status}`);
    return r.json();
  }

  if (v) {
    const tag1 = `v${v}`;
    try {
      return await fetchOnce(`${apiBase}/repos/SagerNet/sing-box/releases/tags/${encodeURIComponent(tag1)}`);
    } catch {
      return await fetchOnce(`${apiBase}/repos/SagerNet/sing-box/releases/tags/${encodeURIComponent(v)}`);
    }
  }

  return fetchOnce(`${apiBase}/repos/SagerNet/sing-box/releases/latest`);
}

function desiredSingBoxAssetExtensions() {
  if (process.platform === 'win32') return ['.zip', '.tar.gz', '.tgz'];
  return ['.tar.gz', '.tgz', '.zip'];
}

function desiredSingBoxAssetTokens() {
  const platform = process.platform;
  const arch = process.arch;

  const plat =
    platform === 'darwin' ? ['darwin', 'macos'] : platform === 'win32' ? ['windows'] : ['linux'];

  const archTokens =
    arch === 'arm64'
      ? ['arm64', 'aarch64']
      : arch === 'x64'
        ? ['amd64', 'x86_64']
        : arch === 'ia32'
          ? ['386', 'i386']
          : [String(arch)];

  return { plat, arch: archTokens };
}

function pickBestSingBoxAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const exts = desiredSingBoxAssetExtensions();
  const tokens = desiredSingBoxAssetTokens();

  const candidates = [];
  for (const a of list) {
    const name = typeof a?.name === 'string' ? a.name : '';
    const url = typeof a?.browser_download_url === 'string' ? a.browser_download_url : '';
    if (!name || !url) continue;
    const lower = name.toLowerCase();
    if (!lower.startsWith('sing-box-')) continue;
    if (!tokens.plat.some((t) => lower.includes(t))) continue;
    if (!tokens.arch.some((t) => lower.includes(t))) continue;
    candidates.push({ name, url });
  }
  if (!candidates.length) return null;

  // Prefer extensions in order.
  for (const ext of exts) {
    const hit = candidates.find((c) => c.name.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return candidates[0];
}

function extractTarGzUsingTar(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', archivePath, '-C', destDir], {
      stdio: process.env.FMA_SINGBOX_DEBUG === '1' ? 'inherit' : 'ignore',
      windowsHide: true,
    });
    proc.once('error', (e) => reject(e || new Error('tar spawn failed')));
    proc.once('exit', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`tar exit ${code}`));
    });
  });
}

function extractZipUsingUnzip(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-o', archivePath, '-d', destDir], {
      stdio: process.env.FMA_SINGBOX_DEBUG === '1' ? 'inherit' : 'ignore',
      windowsHide: true,
    });
    proc.once('error', (e) => reject(e || new Error('unzip spawn failed')));
    proc.once('exit', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`unzip exit ${code}`));
    });
  });
}

function extractZipUsingPowerShell(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const cmd = 'powershell.exe';
    const script = `Expand-Archive -Force -Path '${String(archivePath).replaceAll("'", "''")}' -DestinationPath '${String(
      destDir,
    ).replaceAll("'", "''")}'`;
    const proc = spawn(cmd, ['-NoProfile', '-Command', script], {
      stdio: process.env.FMA_SINGBOX_DEBUG === '1' ? 'inherit' : 'ignore',
      windowsHide: true,
    });
    proc.once('error', (e) => reject(e || new Error('powershell spawn failed')));
    proc.once('exit', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`powershell exit ${code}`));
    });
  });
}

function extractZipUsingTar(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xf', archivePath, '-C', destDir], {
      stdio: process.env.FMA_SINGBOX_DEBUG === '1' ? 'inherit' : 'ignore',
      windowsHide: true,
    });
    proc.once('error', (e) => reject(e || new Error('tar spawn failed')));
    proc.once('exit', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`tar exit ${code}`));
    });
  });
}

async function extractArchive(archivePath, destDir) {
  const p = String(archivePath || '').toLowerCase();
  ensureDir(destDir);
  if (p.endsWith('.tar.gz') || p.endsWith('.tgz')) {
    return extractTarGzUsingTar(archivePath, destDir);
  }
  if (p.endsWith('.zip')) {
    if (process.platform === 'win32') {
      try {
        return await extractZipUsingPowerShell(archivePath, destDir);
      } catch {
        return extractZipUsingTar(archivePath, destDir);
      }
    }
    try {
      return await extractZipUsingUnzip(archivePath, destDir);
    } catch {
      return extractZipUsingTar(archivePath, destDir);
    }
  }
  throw new Error('unsupported archive format');
}

function findFirstFileRecursive(dir, predicate, { maxDepth = 4 } = {}) {
  const root = String(dir || '').trim();
  if (!root) return null;
  const stack = [{ p: root, d: 0 }];
  while (stack.length) {
    const { p, d } = stack.pop();
    let entries = null;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      entries = null;
    }
    if (!entries) continue;
    for (const ent of entries) {
      const full = path.join(p, ent.name);
      if (ent.isFile()) {
        try {
          if (predicate(full, ent.name)) return full;
        } catch {
          // ignore
        }
      } else if (ent.isDirectory() && d < maxDepth) {
        stack.push({ p: full, d: d + 1 });
      }
    }
  }
  return null;
}

let downloadLock = null;

async function ensureSingBoxDownloaded() {
  if (downloadLock) return downloadLock;

  downloadLock = (async () => {
    setPluginStatus({ state: 'checking', message: null });
    const binName = singBoxBinName();
    const installDir = path.join(runtimeDir(), 'sing-box');
    ensureDir(installDir);
    const target = path.join(installDir, binName);
    if (isUsableFile(target)) {
      setPluginStatus({ state: 'ready', bin: target, url: null, message: null });
      return target;
    }

    const urlOverride = String(process.env.FMA_SINGBOX_DOWNLOAD_URL || '').trim();
    const version = String(process.env.FMA_SINGBOX_VERSION || '').trim();

    let url = urlOverride;
    if (!url) {
      const direct = defaultDownloadUrlForCurrentPlatform({ version });
      if (direct) {
        url = direct;
      } else {
        const rel = await fetchGithubReleaseInfo({ version });
        const picked = pickBestSingBoxAsset(rel?.assets);
        if (!picked || !picked.url) {
          throw new Error('无法从 GitHub release 自动选择 sing-box 资源；请设置 FMA_SINGBOX_DOWNLOAD_URL 或手动安装');
        }
        url = picked.url;
      }
    }

    const name = urlBasename(url) || `sing-box-download-${Date.now()}`;
    const archivePath = path.join(installDir, name);
    const tmpExtract = path.join(installDir, `extract-${Date.now()}`);
    setPluginStatus({ state: 'downloading', url, bin: null, message: null });
    try {
      console.log(`[sing-box] downloading: ${url}`);
    } catch {
      // ignore
    }
    await downloadToFile(url, archivePath, { timeoutMs: downloadTimeoutMs() });

    const lower = archivePath.toLowerCase();
    if (lower.endsWith('.zip') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      await extractArchive(archivePath, tmpExtract);
      const found = findFirstFileRecursive(tmpExtract, (_fp, base) => {
        const b = String(base || '').toLowerCase();
        if (process.platform === 'win32') return b === 'sing-box.exe';
        return b === 'sing-box';
      });
      if (!found) throw new Error('解压完成但未找到 sing-box 可执行文件');
      fs.copyFileSync(found, target);
    } else {
      // Assume it's a direct binary download.
      fs.copyFileSync(archivePath, target);
    }

    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(target, 0o755);
      } catch {
        // ignore
      }
    }

    try {
      console.log(`[sing-box] installed: ${target}`);
    } catch {
      // ignore
    }

    setPluginStatus({ state: 'ready', bin: target, url: null, message: null });
    return target;
  })()
    .catch((e) => {
      setPluginStatus({ state: 'error', message: e?.message || String(e), url: null });
      downloadLock = null;
      throw e;
    })
    .finally(() => {
      // keep the lock only during the current attempt; subsequent calls will reuse installed file
      downloadLock = null;
    });

  return downloadLock;
}

function defaultDownloadUrlForCurrentPlatform({ version } = {}) {
  const v = String(version || '').trim() || '1.13.9';
  // NOTE: This is a pinned fallback to avoid GitHub API/rate-limit issues.
  // Users can override with FMA_SINGBOX_DOWNLOAD_URL or FMA_SINGBOX_VERSION.
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return `https://github.com/SagerNet/sing-box/releases/download/v${v}/sing-box-${v}-darwin-arm64.tar.gz`;
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return `https://github.com/SagerNet/sing-box/releases/download/v${v}/sing-box-${v}-windows-amd64.zip`;
  }
  return null;
}

async function preload({ silent = true } = {}) {
  const auto = isAutoDownloadEnabled();
  const bin = resolveSingBoxBin();
  setPluginStatus({ state: 'checking', bin: null, message: null, url: null });

  // If resolveSingBoxBin already returned an existing file path, we're done.
  if (isPathLike(bin) && isUsableFile(bin)) {
    setPluginStatus({ state: 'ready', bin, message: null, url: null });
    return { ok: true, bin, source: 'file' };
  }

  // If it's a PATH lookup (e.g. "sing-box"), probe it quickly.
  try {
    await probeBinary(bin, { args: ['version'], timeoutMs: 2200 });
    setPluginStatus({ state: 'ready', bin, message: null, url: null });
    return { ok: true, bin, source: 'path' };
  } catch (e) {
    const code = e && typeof e === 'object' ? e.code : null;
    if (code !== 'ENOENT') {
      if (!silent) throw e;
      setPluginStatus({ state: 'error', bin: null, message: e?.message || String(e), url: null });
      return { ok: false, bin, source: 'probe', error: e?.message || String(e) };
    }
  }

  if (!auto) {
    setPluginStatus({ state: 'missing', bin: null, message: formatSingBoxNotFoundMessage(bin), url: null });
    return { ok: false, bin, source: 'missing', error: formatSingBoxNotFoundMessage(bin) };
  }

  const installed = await ensureSingBoxDownloaded();
  setPluginStatus({ state: 'ready', bin: installed, message: null, url: null });
  return { ok: true, bin: installed, source: 'download' };
}

function isNodeLink(link) {
  const s = String(link || '').trim();
  return s.startsWith('vless://') || s.startsWith('hysteria2://') || s.startsWith('vmess://');
}

function safeRemarkFromHash(hash) {
  const h = String(hash || '');
  if (!h || !h.startsWith('#')) return '';
  const v = h.slice(1);
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function splitCsvParam(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const parts = s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}

function truthyParam(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return false;
  return v === '1' || v === 'true' || v === 'yes' || v === 'y';
}

function tryDecodeBase64Json(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad === 0 ? normalized : normalized + '='.repeat(4 - pad);
  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const obj = JSON.parse(decoded);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function vmessOutboundFromLink(rawLink) {
  const raw = String(rawLink || '').trim();
  if (!raw.startsWith('vmess://')) throw new Error('invalid vmess link');
  const payload = tryDecodeBase64Json(raw.slice('vmess://'.length));
  if (!payload) throw new Error('invalid vmess payload');

  const server = String(payload.add || payload.server || '').trim();
  const serverPort = parsePort(payload.port, 443);
  const uuid = String(payload.id || payload.uuid || '').trim();
  if (!server) throw new Error('vmess node missing server host');
  if (!uuid) throw new Error('vmess node missing uuid');

  const out = {
    type: 'vmess',
    tag: 'proxy',
    server,
    server_port: serverPort,
    uuid,
  };

  const alterIdRaw = payload.aid != null ? Number(payload.aid) : payload.alterId != null ? Number(payload.alterId) : NaN;
  if (Number.isFinite(alterIdRaw)) out.alter_id = Math.max(0, Math.floor(alterIdRaw));

  const security = String(payload.scy || payload.security || payload.cipher || '').trim();
  if (security) out.security = security;

  const tlsVal = String(payload.tls || '').trim().toLowerCase();
  const tlsEnabled = tlsVal === 'tls' || tlsVal === '1' || tlsVal === 'true';
  const sni = String(payload.sni || payload.servername || payload.serverName || '').trim();
  const alpn = splitCsvParam(payload.alpn);
  if (tlsEnabled) {
    out.tls = {
      enabled: true,
      server_name: sni || server,
      insecure: false,
    };
    if (alpn) out.tls.alpn = alpn;
  }

  const netType = String(payload.net || payload.network || '').trim().toLowerCase();
  const wsHost = String(payload.host || '').trim();
  const path = String(payload.path || '').trim();
  if (netType === 'ws') {
    const t = { type: 'ws', path: path || '/' };
    if (wsHost) t.headers = { Host: wsHost };
    out.transport = t;
  } else if (netType === 'grpc') {
    const serviceName = path;
    if (serviceName) out.transport = { type: 'grpc', service_name: serviceName };
    else out.transport = { type: 'grpc' };
  }

  return { outbound: out, remark: String(payload.ps || payload.remark || '').trim() || '' };
}

function vlessOutboundFromLink(u) {
  const uuid = String(u.username || u.password || '').trim();
  const server = String(u.hostname || '').trim();
  const serverPort = parsePort(u.port, 443);

  const params = u.searchParams;
  const transportType = String(params.get('type') || '').trim().toLowerCase();
  const security = String(params.get('security') || '').trim().toLowerCase();

  const sni = String(params.get('sni') || params.get('serverName') || '').trim();
  const insecure = truthyParam(params.get('insecure') || params.get('allowInsecure'));
  const alpn = splitCsvParam(params.get('alpn'));
  const flow = String(params.get('flow') || '').trim();

  const fp = String(params.get('fp') || '').trim();
  const pbk = String(params.get('pbk') || '').trim();
  const sid = String(params.get('sid') || '').trim();
  const spx = String(params.get('spx') || '').trim();

  const out = {
    type: 'vless',
    tag: 'proxy',
    server,
    server_port: serverPort,
    uuid,
  };
  if (flow) out.flow = flow;

  const tlsEnabled = security === 'tls' || security === 'reality';
  if (tlsEnabled) {
    out.tls = {
      enabled: true,
      server_name: sni || server,
      insecure,
    };
    if (alpn) out.tls.alpn = alpn;
    if (fp) out.tls.utls = { enabled: true, fingerprint: fp };
    if (security === 'reality' || pbk) {
      out.tls.reality = { enabled: true };
      if (pbk) out.tls.reality.public_key = pbk;
      if (sid) out.tls.reality.short_id = sid;
      if (spx) out.tls.reality.spider_x = spx;
    }
  }

  if (transportType === 'ws') {
    const wsPath = String(params.get('path') || '').trim() || '/';
    const wsHost = String(params.get('host') || '').trim();
    const t = { type: 'ws', path: wsPath };
    if (wsHost) t.headers = { Host: wsHost };
    out.transport = t;
  } else if (transportType === 'grpc') {
    const serviceName = String(params.get('serviceName') || params.get('service') || '').trim();
    if (serviceName) out.transport = { type: 'grpc', service_name: serviceName };
    else out.transport = { type: 'grpc' };
  }

  return out;
}

function hysteria2OutboundFromLink(u) {
  const password = String(u.username || u.password || '').trim();
  const server = String(u.hostname || '').trim();
  const serverPort = parsePort(u.port, 443);

  const params = u.searchParams;
  const sni = String(params.get('sni') || params.get('serverName') || '').trim();
  const insecure = truthyParam(params.get('insecure') || params.get('allowInsecure'));
  const alpn = splitCsvParam(params.get('alpn'));

  const out = {
    type: 'hysteria2',
    tag: 'proxy',
    server,
    server_port: serverPort,
    password,
    tls: {
      enabled: true,
      server_name: sni || server,
      insecure,
    },
  };
  if (alpn) out.tls.alpn = alpn;
  return out;
}

function buildSingBoxConfigFromNodeLink(link, { listen, listenPort } = {}) {
  const raw = String(link || '').trim();
  if (!isNodeLink(raw)) throw new Error('unsupported node link');

  const listenHost = String(listen || '').trim() || localListenHost();
  const inboundPort = parsePort(listenPort, localListenPort());

  let outbound;
  if (raw.startsWith('vmess://')) {
    ({ outbound } = vmessOutboundFromLink(raw));
  } else {
    let u;
    try {
      // NOTE: Node's WHATWG URL does not apply IDN punycode conversion for non-special schemes.
      // Parse with a fake https:// scheme so hostname is normalized (important for 中文域名).
      const fake = raw.startsWith('vless://')
        ? raw.replace(/^vless:\/\//i, 'https://')
        : raw.replace(/^hysteria2:\/\//i, 'https://');
      u = new URL(fake);
    } catch {
      throw new Error('invalid node link');
    }
    if (raw.startsWith('vless://')) outbound = vlessOutboundFromLink(u);
    else outbound = hysteria2OutboundFromLink(u);
  }

  const server = String(outbound?.server || '').trim();
  const outboundServerPort = Number(outbound?.server_port);
  if (!server) throw new Error('node missing server host');
  if (!Number.isFinite(outboundServerPort) || outboundServerPort <= 0) throw new Error('node missing server port');
  if (outbound.type === 'vless' && !String(outbound.uuid || '').trim()) throw new Error('vless node missing uuid');
  if (outbound.type === 'hysteria2' && !String(outbound.password || '').trim()) {
    throw new Error('hysteria2 node missing password');
  }
  if (outbound.type === 'vmess' && !String(outbound.uuid || '').trim()) throw new Error('vmess node missing uuid');

  const config = {
    log: { level: 'error', timestamp: true },
    inbounds: [
      {
        type: 'socks',
        tag: 'in',
        listen: listenHost,
        listen_port: inboundPort,
      },
    ],
    outbounds: [
      outbound,
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
    ],
    route: {
      final: 'proxy',
    },
  };
  return { config, listenHost, listenPort: inboundPort, outbound };
}

function tcpPing(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(true);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish());
    sock.once('timeout', () => finish(new Error('timeout')));
    sock.once('error', (e) => finish(e || new Error('error')));
  });
}

async function assertPortFree({ host, port } = {}) {
  const h = String(host || '').trim() || '127.0.0.1';
  const p = parsePort(port, null);
  if (!p) throw new Error('invalid port');

  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref?.();
    srv.once('error', (e) => {
      try {
        srv.close();
      } catch {
        // ignore
      }
      if (e && typeof e === 'object' && e.code === 'EADDRINUSE') {
        reject(new Error(`本地端口被占用：${h}:${p}（请关闭占用该端口的进程，或改 FMA_SINGBOX_PORT）`));
        return;
      }
      reject(e || new Error('listen error'));
    });
    srv.listen({ host: h, port: p }, () => {
      try {
        srv.close(() => resolve(true));
      } catch {
        resolve(true);
      }
    });
  });
}

async function waitPortOpen({ host, port, timeoutMs, shouldAbort } = {}) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 0);
  let lastErr = null;
  while (Date.now() < deadline) {
    if (typeof shouldAbort === 'function') {
      const msg = shouldAbort();
      if (msg) throw new Error(msg);
    }
    try {
      await tcpPing(host, port, 400);
      return true;
    } catch (e) {
      lastErr = e;
      await sleep(120);
    }
  }
  const hint = lastErr && lastErr.message ? String(lastErr.message) : 'unknown';
  throw new Error(`sing-box 未就绪：${host}:${port}（${hint}）`);
}

function buildMaskedNodeTitle(link) {
  const raw = String(link || '').trim();
  if (!raw) return 'node';
  if (raw.startsWith('vmess://')) {
    try {
      const { outbound, remark } = vmessOutboundFromLink(raw);
      const hp = outbound.server_port ? `${outbound.server}:${outbound.server_port}` : outbound.server;
      return remark ? `vmess ${remark} (${hp})` : `vmess ${hp}`;
    } catch {
      return 'vmess';
    }
  }
  try {
    const fake = raw.startsWith('vless://')
      ? raw.replace(/^vless:\/\//i, 'https://')
      : raw.replace(/^hysteria2:\/\//i, 'https://');
    const u = new URL(fake);
    const proto = raw.startsWith('vless://') ? 'vless' : raw.startsWith('hysteria2://') ? 'hysteria2' : u.protocol.replace(':', '');
    const host = u.hostname || '';
    const port = u.port || '';
    const remark = safeRemarkFromHash(u.hash);
    const hp = port ? `${host}:${port}` : host;
    return remark ? `${proto} ${remark} (${hp})` : `${proto} ${hp}`;
  } catch {
    return raw.slice(0, 80);
  }
}

const instances = new Map(); // rawNodeLink -> instance

function instanceSummary(inst) {
  if (!inst) return null;
  return {
    key: inst.key,
    running: Boolean(inst.proc),
    refs: inst.refs || 0,
    listenHost: inst.listenHost,
    listenPort: inst.listenPort,
    configPath: inst.configPath,
    logPath: inst.logPath,
    startedAt: inst.startedAt || null,
    lastError: inst.lastError || null,
  };
}

async function stopProc(proc) {
  if (!proc) return;
  try {
    proc.removeAllListeners();
  } catch {
    // ignore
  }

  let exited = false;
  const done = () => {
    exited = true;
  };
  try {
    proc.once('exit', done);
  } catch {
    // ignore
  }

  try {
    proc.kill();
  } catch {
    // ignore
  }

  const timeout = stopTimeoutMs();
  const deadline = Date.now() + timeout;
  while (!exited && Date.now() < deadline) {
    await sleep(50);
  }

  if (!exited) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}

async function stopInstance(key) {
  const k = String(key || '').trim();
  if (!k) return;
  const inst = instances.get(k);
  if (!inst) return;
  inst.refs = 0;
  const proc = inst.proc;
  inst.proc = null;
  inst.startedAt = null;
  if (proc) await stopProc(proc);
  instances.delete(k);
}

async function stop() {
  const keys = Array.from(instances.keys());
  for (const k of keys) {
    try {
      await stopInstance(k);
    } catch {
      // ignore
    }
  }
}

function isPortAssigned(port) {
  const p = parsePort(port, null);
  if (!p) return false;
  for (const inst of instances.values()) {
    if (!inst) continue;
    if (Number(inst.listenPort) === p) return true;
  }
  return false;
}

async function pickFreePort({ host, preferredPort, range = 80 } = {}) {
  const h = String(host || '').trim() || '127.0.0.1';
  const base = parsePort(preferredPort, 53182);
  const r = Math.max(1, Math.min(500, Number(range) || 0));

  // Try preferred first.
  if (!isPortAssigned(base)) {
    try {
      await assertPortFree({ host: h, port: base });
      return base;
    } catch {
      // ignore
    }
  }

  // Scan upwards.
  for (let i = 1; i <= r; i += 1) {
    const p = base + i;
    if (p > 65535) break;
    if (isPortAssigned(p)) continue;
    try {
      await assertPortFree({ host: h, port: p });
      return p;
    } catch {
      // ignore
    }
  }

  throw new Error(`无法找到可用端口（从 ${h}:${base} 开始扫描 ${r} 个端口；可改 FMA_SINGBOX_PORT）`);
}

function getOrCreateInstance(raw, { listenHost, listenPort } = {}) {
  const key = String(raw || '').trim();
  if (!key) return null;
  if (instances.has(key)) return instances.get(key);
  const inst = {
    key,
    proc: null,
    refs: 0,
    listenHost: listenHost || localListenHost(),
    listenPort: listenPort != null ? Number(listenPort) : null,
    configPath: null,
    logPath: null,
    startedAt: null,
    lastError: null,
  };
  instances.set(key, inst);
  return inst;
}

async function ensureRunningForNodeLink(nodeLink, { listenHost, listenPort } = {}) {
  const raw = String(nodeLink || '').trim();
  if (!isNodeLink(raw)) throw new Error('unsupported node link');

  const inst = getOrCreateInstance(raw, { listenHost, listenPort });
  if (!inst) throw new Error('invalid node link');

  if (inst.proc) {
    return {
      proxy: { server: `socks5://${inst.listenHost}:${inst.listenPort}` },
      via: `socks5://${inst.listenHost}:${inst.listenPort}`,
      title: buildMaskedNodeTitle(raw),
      restarted: false,
    };
  }

  const dir = runtimeDir();
  ensureDir(dir);

  const host = listenHost || inst.listenHost || localListenHost();
  const preferred = listenPort != null ? listenPort : inst.listenPort != null ? inst.listenPort : localListenPort();
  const pickedPort = await pickFreePort({ host, preferredPort: preferred });

  const built = buildSingBoxConfigFromNodeLink(raw, { listen: host, listenPort: pickedPort });

  // Improve errors: fail fast if the local port is already occupied.
  // (pickFreePort already checks, keep as a belt-and-suspenders)
  await assertPortFree({ host: built.listenHost, port: built.listenPort });

  const configPath = path.join(dir, `sing-box-${built.listenPort}.json`);
  writeJsonAtomicSync(configPath, built.config);

  const args = ['run', '-c', configPath];

  async function startOnce(binPath) {
    const logPath = path.join(dir, `sing-box-${built.listenPort}.log`);
    const debug = process.env.FMA_SINGBOX_DEBUG === '1';
    if (!debug) {
      try {
        fs.writeFileSync(logPath, '');
      } catch {
        // ignore
      }
    }

    const proc = spawn(binPath, args, {
      stdio: debug ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let spawnErr = null;
    inst.proc = proc;
    inst.listenHost = built.listenHost;
    inst.listenPort = built.listenPort;
    inst.configPath = configPath;
    inst.startedAt = Date.now();
    inst.logPath = logPath;
    inst.lastError = null;

    if (!debug) {
      try {
        const out = proc.stdout;
        const err = proc.stderr;
        if (out && typeof out.on === 'function') {
          out.on('data', (buf) => {
            try {
              fs.appendFileSync(logPath, String(buf || ''), { encoding: 'utf8' });
            } catch {
              // ignore
            }
          });
        }
        if (err && typeof err.on === 'function') {
          err.on('data', (buf) => {
            try {
              fs.appendFileSync(logPath, String(buf || ''), { encoding: 'utf8' });
            } catch {
              // ignore
            }
          });
        }
      } catch {
        // ignore
      }
    }

    proc.once('error', (e) => {
      spawnErr = e;
      if (inst && inst.proc === proc) {
        inst.proc = null;
        if (e && typeof e === 'object' && e.code === 'ENOENT') {
          inst.lastError = formatSingBoxNotFoundMessage(binPath);
        } else {
          inst.lastError = `sing-box spawn failed: ${e?.message || e}`;
        }
      }
    });
    proc.once('exit', (code, signal) => {
      if (inst && inst.proc === proc) {
        inst.proc = null;
        const base = `sing-box exited: code=${code} signal=${signal}`;
        const hint = inst?.logPath
          ? `（查看日志：${inst.logPath}；也可用 FMA_SINGBOX_DEBUG=1 直接打印 sing-box 日志）`
          : '（可用 FMA_SINGBOX_DEBUG=1 直接打印 sing-box 日志）';
        inst.lastError = `${base} ${hint}`;
      }
    });

    try {
      await waitPortOpen({
        host: built.listenHost,
        port: built.listenPort,
        timeoutMs: startTimeoutMs(),
        shouldAbort: () => {
          if (spawnErr) {
            if (spawnErr && typeof spawnErr === 'object' && spawnErr.code === 'ENOENT') {
              return `sing-box 启动失败：${formatSingBoxNotFoundMessage(binPath)}`;
            }
            return `sing-box 启动失败：${spawnErr?.message || spawnErr}`;
          }
          if (!inst.proc) return inst.lastError || 'sing-box exited';
          return null;
        },
      });
    } catch (e) {
      if (spawnErr && typeof spawnErr === 'object' && spawnErr.code === 'ENOENT') {
        // Bubble up for auto-download retry.
        const err = new Error(`sing-box missing (ENOENT)`);
        err.cause = spawnErr;
        throw err;
      }
      throw e;
    }

    return {
      proxy: { server: `socks5://${built.listenHost}:${built.listenPort}` },
      via: `socks5://${built.listenHost}:${built.listenPort}`,
      title: buildMaskedNodeTitle(raw),
      restarted: true,
    };
  }

  let binPath = resolveSingBoxBin();
  try {
    return await startOnce(binPath);
  } catch (e) {
    const code = e?.cause?.code;
    if (code === 'ENOENT' && isAutoDownloadEnabled()) {
      try {
        const installed = await ensureSingBoxDownloaded();
        binPath = installed;
        return await startOnce(binPath);
      } catch (e2) {
        const msg = e2 && e2.message ? String(e2.message) : String(e2);
        throw new Error(`sing-box 自动下载失败：${msg}`);
      }
    }
    // Re-throw with a nicer message for ENOENT when auto-download disabled.
    if (code === 'ENOENT') throw new Error(formatSingBoxNotFoundMessage(binPath));
    throw e;
  }

}

async function acquireForNodeLink(nodeLink, opts) {
  const raw = String(nodeLink || '').trim();
  const r = await ensureRunningForNodeLink(raw, opts);
  const inst = instances.get(raw);
  if (inst) inst.refs = Math.max(0, Number(inst.refs) || 0) + 1;
  let released = false;
  return {
    ...r,
    release: async () => {
      if (released) return;
      released = true;
      const it = instances.get(raw);
      if (!it) return;
      it.refs = Math.max(0, (Number(it.refs) || 0) - 1);
      if (it.refs === 0) await stopInstance(raw);
    },
  };
}

function getStatus() {
  const list = Array.from(instances.values())
    .map(instanceSummary)
    .filter(Boolean);
  const running = list.filter((x) => x.running);
  const refsTotal = list.reduce((sum, x) => sum + (Number(x.refs) || 0), 0);
  return {
    running: running.length > 0,
    runningCount: running.length,
    refs: refsTotal,
    instances: list,
  };
}

module.exports = {
  isNodeLink,
  ensureRunningForNodeLink,
  acquireForNodeLink,
  preload,
  stop,
  getStatus,
  getPluginStatus,
  localListenHost,
  localListenPort,
};
