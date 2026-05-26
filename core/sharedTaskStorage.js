const fs = require('fs');
const os = require('os');
const path = require('path');

const STORAGE_ROOT_KEY_SUBMIT = 'flow_submit_assets';
const STORAGE_ROOT_KEY_OUTPUT = 'flow_task_outputs';

function sharedTaskRoot() {
  const raw = String(process.env.FLOW_TASK_STORAGE_ROOT || '').trim();
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), '.flow-task-system');
}

function rootDirForKey(storageRootKey) {
  const key = String(storageRootKey || '').trim();
  if (key === STORAGE_ROOT_KEY_SUBMIT) return path.join(sharedTaskRoot(), 'submit-assets');
  if (key === STORAGE_ROOT_KEY_OUTPUT) return path.join(sharedTaskRoot(), 'task-outputs');
  throw new Error(`unsupported storageRootKey: ${key}`);
}

function ensureRootDir(storageRootKey) {
  const dir = rootDirForKey(storageRootKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeFileName(name) {
  return String(name || 'asset')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'asset';
}

function safeResolve(rootDir, relativePath) {
  const base = path.resolve(rootDir);
  const abs = path.resolve(base, String(relativePath || ''));
  if (abs !== base && !abs.startsWith(`${base}${path.sep}`)) {
    throw new Error('invalid relativePath');
  }
  return abs;
}

function buildSubmitAssetLocation({ machineId, assetId, fileName }) {
  const rootDir = ensureRootDir(STORAGE_ROOT_KEY_SUBMIT);
  const safeMachineId = sanitizeFileName(machineId || 'unknown-machine');
  const safeAssetId = sanitizeFileName(assetId || 'asset');
  const safeName = sanitizeFileName(fileName || 'reference.png');
  const relativePath = path.join(safeMachineId, safeAssetId, safeName);
  const absolutePath = safeResolve(rootDir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  return {
    storageRootKey: STORAGE_ROOT_KEY_SUBMIT,
    rootDir,
    relativePath,
    absolutePath,
  };
}

function resolveAssetPath({ storageRootKey, relativePath }) {
  const rootDir = rootDirForKey(storageRootKey);
  return safeResolve(rootDir, relativePath);
}

module.exports = {
  STORAGE_ROOT_KEY_OUTPUT,
  STORAGE_ROOT_KEY_SUBMIT,
  buildSubmitAssetLocation,
  resolveAssetPath,
  rootDirForKey,
  sanitizeFileName,
  sharedTaskRoot,
};
