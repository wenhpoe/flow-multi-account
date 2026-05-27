const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const OSS = require('ali-oss');

const taskStorage = require('./sharedTaskStorage');

const DEFAULT_OSS_PREFIX = 'flow-task-system';

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
  const value = String(relativePath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!value) throw new Error('relativePath required');
  return value;
}

function buildObjectKey({ storageRootKey, relativePath }) {
  const prefix = normalizePrefix(process.env.FLOW_OSS_PREFIX || DEFAULT_OSS_PREFIX);
  const base = `${storageSegment(storageRootKey)}/${normalizeRelativePath(relativePath)}`;
  return prefix ? `${prefix}/${base}` : base;
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`OSS 配置缺失：${name}`);
  return value;
}

function normalizeEndpoint(endpoint) {
  const value = String(endpoint || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!value) throw new Error('OSS 配置缺失：OSS_ENDPOINT');
  return value;
}

function createClient() {
  const endpoint = normalizeEndpoint(requiredEnv('OSS_ENDPOINT'));
  return new OSS({
    accessKeyId: requiredEnv('OSS_ACCESS_KEY_ID'),
    accessKeySecret: requiredEnv('OSS_ACCESS_KEY_SECRET'),
    bucket: requiredEnv('OSS_BUCKET'),
    endpoint,
    secure: String(process.env.OSS_SECURE || 'true').trim().toLowerCase() !== 'false',
    timeout: Number(process.env.FLOW_OSS_TIMEOUT_MS || 120000) || 120000,
  });
}

function encodeObjectKey(objectKey) {
  return String(objectKey || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function buildPublicUrl(objectKey) {
  const cdn = String(process.env.OSS_CDN || '').trim().replace(/\/+$/, '');
  if (cdn) return `${cdn}/${encodeObjectKey(objectKey)}`;
  const bucket = requiredEnv('OSS_BUCKET');
  const endpoint = normalizeEndpoint(requiredEnv('OSS_ENDPOINT'));
  return `https://${bucket}.${endpoint}/${encodeObjectKey(objectKey)}`;
}

async function uploadFile({ localPath, objectKey, contentType }) {
  const targetPath = path.resolve(String(localPath || ''));
  if (!fs.existsSync(targetPath)) throw new Error(`上传文件不存在：${targetPath}`);
  const finalObjectKey = String(objectKey || '').trim().replace(/^\/+/, '');
  if (!finalObjectKey) throw new Error('objectKey required');
  const headers = {};
  if (contentType) headers['Content-Type'] = String(contentType).trim();
  try {
    const client = createClient();
    await client.put(finalObjectKey, targetPath, Object.keys(headers).length ? { headers } : undefined);
    return {
      ok: true,
      objectKey: finalObjectKey,
      publicUrl: buildPublicUrl(finalObjectKey),
      sizeBytes: fs.statSync(targetPath).size,
      contentType: String(contentType || '').trim() || null,
    };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    throw new Error(`OSS 上传失败：${message}`);
  }
}

async function fetchRemoteDataUrl({ remoteUrl, mimeType }) {
  const url = String(remoteUrl || '').trim();
  if (!url) throw new Error('remoteUrl required');
  new URL(url);
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
