const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const OSS = require('ali-oss');
const { S3Client, PutObjectCommand, GetBucketLocationCommand } = require('@aws-sdk/client-s3');

const taskStorage = require('./sharedTaskStorage');

const DEFAULT_OSS_PREFIX = 'flow-task-system';

function assetTransportMode() {
  const value = String(process.env.FLOW_TASK_ASSET_TRANSPORT || 'oss').trim().toLowerCase();
  if (value === 'local') return 'local';
  if (value === 's3') return 's3';
  return 'oss';
}

function isOssTransportEnabled() {
  return assetTransportMode() === 'oss';
}

function isS3TransportEnabled() {
  return assetTransportMode() === 's3';
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

function requiredAwsEnv(primaryName, fallbackName) {
  const value = String(process.env[primaryName] || '').trim() || String(process.env[fallbackName] || '').trim();
  if (!value) throw new Error(`S3 配置缺失：${primaryName}`);
  return value;
}

function normalizeAwsRegion(value) {
  const region = String(value || '').trim();
  return region || 'us-east-1';
}

function normalizeS3Endpoint(value) {
  const endpoint = String(value || '').trim().replace(/\/+$/, '');
  if (!endpoint) return null;
  if (!/^https?:\/\//i.test(endpoint)) return `https://${endpoint}`;
  return endpoint;
}

async function resolveS3BucketRegion({ bucket, accessKeyId, secretAccessKey }) {
  const explicit = String(process.env.S3_REGION || process.env.AWS_REGION || '').trim();
  if (explicit) return explicit;
  const client = new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
    endpoint: normalizeS3Endpoint(process.env.S3_ENDPOINT),
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || '').trim() === '1',
  });
  const response = await client.send(new GetBucketLocationCommand({ Bucket: bucket }));
  const constraint = response && response.LocationConstraint ? String(response.LocationConstraint).trim() : '';
  // AWS uses empty/null LocationConstraint for us-east-1.
  return constraint || 'us-east-1';
}

async function createS3Client() {
  const bucket = String(process.env.S3_BUCKET || process.env.OSS_BUCKET || '').trim();
  if (!bucket) throw new Error('S3 配置缺失：S3_BUCKET');
  const accessKeyId = requiredAwsEnv('AWS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_ID');
  const secretAccessKey = requiredAwsEnv('AWS_SECRET_ACCESS_KEY', 'OSS_ACCESS_KEY_SECRET');
  const region = normalizeAwsRegion(
    String(process.env.S3_REGION || process.env.AWS_REGION || '').trim()
      || (await resolveS3BucketRegion({ bucket, accessKeyId, secretAccessKey }))
  );
  return {
    bucket,
    region,
    client: new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      endpoint: normalizeS3Endpoint(process.env.S3_ENDPOINT),
      forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || '').trim() === '1',
    }),
  };
}

function encodeObjectKey(objectKey) {
  return String(objectKey || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function buildPublicUrl(objectKey) {
  const cdn = String(process.env.FLOW_ASSET_CDN || process.env.S3_CDN || process.env.OSS_CDN || '')
    .trim()
    .replace(/\/+$/, '');
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
  const transport = assetTransportMode();
  if (transport === 'local') {
    return {
      ok: false,
      objectKey: finalObjectKey,
      publicUrl: null,
      sizeBytes: fs.statSync(targetPath).size,
      contentType: String(contentType || '').trim() || null,
    };
  }
  if (transport === 's3') {
    try {
      const { bucket, client } = await createS3Client();
      const body = fs.createReadStream(targetPath);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: finalObjectKey,
          Body: body,
          ContentType: headers['Content-Type'] || undefined,
        })
      );
      return {
        ok: true,
        objectKey: finalObjectKey,
        publicUrl: buildPublicUrl(finalObjectKey),
        sizeBytes: fs.statSync(targetPath).size,
        contentType: String(contentType || '').trim() || null,
      };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      throw new Error(`S3 上传失败：${message}`);
    }
  }
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
  isS3TransportEnabled,
  uploadFile,
};
