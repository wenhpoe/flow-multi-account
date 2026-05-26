const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const taskStorage = require('./sharedTaskStorage');

const execFileAsync = promisify(execFile);
const DEFAULT_OSS_PREFIX = 'flow-task-system';
const DEFAULT_TIMEOUT_MS = 120000;

function assetTransportMode() {
  const value = String(process.env.FLOW_TASK_ASSET_TRANSPORT || 'oss').trim().toLowerCase();
  return value === 'local' ? 'local' : 'oss';
}

function isOssTransportEnabled() {
  return assetTransportMode() === 'oss';
}

function normalizePrefix(input) {
  const value = String(input || '').trim().replace(/^\/+|\/+$/g, '');
  return value || DEFAULT_OSS_PREFIX;
}

function storageSegment(storageRootKey) {
  const key = String(storageRootKey || '').trim();
  if (key === taskStorage.STORAGE_ROOT_KEY_SUBMIT) return 'submit-assets';
  if (key === taskStorage.STORAGE_ROOT_KEY_OUTPUT) return 'task-outputs';
  throw new Error(`unsupported storageRootKey: ${key}`);
}

function normalizeRelativePath(relativePath) {
  const value = String(relativePath || '').trim().replace(/\\/g, '/').replace(/^\/+/g, '');
  if (!value) throw new Error('relativePath required');
  return value;
}

function buildObjectKey({ storageRootKey, relativePath }) {
  const prefix = normalizePrefix(process.env.FLOW_OSS_PREFIX || DEFAULT_OSS_PREFIX);
  const base = `${storageSegment(storageRootKey)}/${normalizeRelativePath(relativePath)}`;
  return prefix ? `${prefix}/${base}` : base;
}

function candidateProjectRoots() {
  const seen = new Set();
  const roots = [];
  const add = (value) => {
    const resolved = path.resolve(String(value || ''));
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    roots.push(resolved);
  };
  add(path.resolve(__dirname, '..'));
  if (process.resourcesPath) {
    add(path.join(process.resourcesPath, 'app.asar.unpacked'));
  }
  return roots;
}

function resolveProjectRoot() {
  const roots = candidateProjectRoots();
  for (const root of roots) {
    if (fs.existsSync(path.join(root, 'oss_toolkit'))) return root;
  }
  return roots[0];
}

function resolveHelperScriptPath() {
  for (const root of candidateProjectRoots()) {
    const candidate = path.join(root, 'core', 'python', 'oss_bridge.py');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(resolveProjectRoot(), 'core', 'python', 'oss_bridge.py');
}

function pythonCandidates() {
  const discovered = [];
  for (const root of candidateProjectRoots()) {
    discovered.push(path.join(root, '.venv', 'bin', 'python'));
    discovered.push(path.join(root, 'venv', 'bin', 'python'));
    discovered.push(path.join(root, '.venv', 'Scripts', 'python.exe'));
    discovered.push(path.join(root, 'venv', 'Scripts', 'python.exe'));
  }
  return Array.from(
    new Set(
      [
        process.env.FLOW_OSS_PYTHON_BIN,
        ...discovered,
        process.env.PYTHON_BIN,
        process.env.PYTHON3_BIN,
        'python3',
        'python',
      ]
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ),
  );
}

function explainHelperError(pythonBin, err) {
  const stderr = String(err?.stderr || '').trim();
  const stdout = String(err?.stdout || '').trim();
  const message = stderr || stdout || err?.message || 'unknown error';
  if (message.includes("No module named 'oss2'") || message.includes('No module named "oss2"')) {
    return new Error(
      `OSS Python 解释器 ${pythonBin} 缺少 oss2，请先安装 oss2，或把 FLOW_OSS_PYTHON_BIN 指向已安装 oss2 的解释器`,
    );
  }
  if (message.includes('OSS config') && message.includes('missing')) {
    return new Error(`OSS 配置缺失：${message}`);
  }
  return new Error(`OSS 上传失败：${message}`);
}

async function runHelper(args) {
  const helperScript = resolveHelperScriptPath();
  if (!fs.existsSync(helperScript)) {
    throw new Error(`OSS helper script not found: ${helperScript}`);
  }
  const cwd = resolveProjectRoot();
  let lastError = null;
  for (const pythonBin of pythonCandidates()) {
    try {
      const { stdout } = await execFileAsync(pythonBin, [helperScript, ...args], {
        cwd,
        env: process.env,
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      const text = String(stdout || '').trim();
      if (!text) return {};
      return JSON.parse(text);
    } catch (err) {
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        lastError = new Error(`找不到 Python 解释器：${pythonBin}`);
        continue;
      }
      lastError = explainHelperError(pythonBin, err);
      const stderr = String(err?.stderr || '').trim();
      if (stderr && !/No module named ['"]oss2['"]/.test(stderr)) break;
    }
  }
  throw lastError || new Error('OSS helper 调用失败');
}

async function uploadFile({ localPath, objectKey, contentType }) {
  const targetPath = path.resolve(String(localPath || ''));
  if (!fs.existsSync(targetPath)) throw new Error(`上传文件不存在：${targetPath}`);
  const args = ['upload', '--local-path', targetPath, '--object-key', String(objectKey || '').trim()];
  if (contentType) args.push('--content-type', String(contentType).trim());
  return runHelper(args);
}

async function fetchRemoteDataUrl({ remoteUrl, mimeType }) {
  const url = String(remoteUrl || '').trim();
  if (!url) throw new Error('remoteUrl required');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`远端资源获取失败：HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const headerMimeType = String(res.headers.get('content-type') || '')
    .split(';')[0]
    .trim();
  const finalMimeType = String(mimeType || '').trim() || headerMimeType || 'application/octet-stream';
  return `data:${finalMimeType};base64,${bytes.toString('base64')}`;
}

module.exports = {
  buildObjectKey,
  fetchRemoteDataUrl,
  isOssTransportEnabled,
  uploadFile,
};
