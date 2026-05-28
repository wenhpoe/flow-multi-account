const fs = require('fs');
const path = require('path');

const deviceState = require('./deviceState');
const ossBridge = require('./ossBridge');
const { readSettings, writeSettings } = require('./settingsStore');
const taskClient = require('./taskClient');
const taskStorage = require('./sharedTaskStorage');

const DEFAULT_ASPECT_RATIO = 'IMAGE_ASPECT_RATIO_PORTRAIT';
const DEFAULT_MODEL_NAME = 'GEM_PIX_2';
const DEFAULT_SPEED = 'balanced';
const DEFAULT_CHANNEL = 'flow';
const DEFAULT_PROVIDER = '1';
const DEFAULT_PRIORITY = 50;
const DEFAULT_EXPIRE_HOURS = 24;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_RESOLUTION = '720p';
const MAX_MESSAGES = 80;
const MAX_LOG_LINES = 10;
const MAX_SEEDANCE_REFERENCE_IMAGES = 9;
const RESTORE_BATCH_LIMIT = Math.max(10, Math.floor(MAX_MESSAGES / 2));

const VALID_ASPECT_RATIOS = new Set([
  'IMAGE_ASPECT_RATIO_PORTRAIT',
  'IMAGE_ASPECT_RATIO_SQUARE',
  'IMAGE_ASPECT_RATIO_LANDSCAPE',
  'IMAGE_ASPECT_RATIO_3_4',
  'IMAGE_ASPECT_RATIO_4_3',
]);
const VALID_SPEEDS = new Set(['safe', 'balanced', 'fast']);
const VALID_TASK_TYPES = new Set(['image', 'video']);
const VALID_RESOLUTIONS = new Set(['480p', '720p', '1080p']);

function resolveDefaultModelName(channel) {
  return String(channel || '').trim().toLowerCase() === 'seedance'
    ? 'dreamina-seedance-2-0-fast-260128'
    : DEFAULT_MODEL_NAME;
}

const runtime = {
  messages: [],
  assets: new Map(),
  jobs: new Map(),
  settingsOverride: null,
  hydrated: false,
  hydrationPromise: null,
  lastHydratedAt: null,
  stateRevision: 0,
  stateCache: null,
  stateCacheKey: '',
};

const FIXED_EXECUTOR_SERVICE = 'auto-gen';

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markStateDirty() {
  runtime.stateRevision += 1;
  runtime.stateCache = null;
  runtime.stateCacheKey = '';
}

function sanitizeFilename(name) {
  return String(name || 'asset')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'asset';
}

function mimeToExtension(mimeType) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
  };
  return map[String(mimeType || '').toLowerCase()] || '.bin';
}

function mimeFromPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  return 'application/octet-stream';
}

function normalizeSettings(input) {
  const payload = input && typeof input === 'object' ? input : {};
  const aspectRatio = VALID_ASPECT_RATIOS.has(String(payload.aspectRatio || '').trim())
    ? String(payload.aspectRatio).trim()
    : DEFAULT_ASPECT_RATIO;
  const humanSpeedPreset = VALID_SPEEDS.has(String(payload.humanSpeedPreset || '').trim().toLowerCase())
    ? String(payload.humanSpeedPreset).trim().toLowerCase()
    : DEFAULT_SPEED;
  const taskType = VALID_TASK_TYPES.has(String(payload.taskType || '').trim().toLowerCase())
    ? String(payload.taskType).trim().toLowerCase()
    : 'image';
  const priority = Number.isFinite(Number(payload.priority))
    ? Math.max(1, Math.min(100, Math.round(Number(payload.priority))))
    : DEFAULT_PRIORITY;
  const expireHours = Number.isFinite(Number(payload.expireHours))
    ? Math.max(1, Math.min(72, Math.round(Number(payload.expireHours))))
    : DEFAULT_EXPIRE_HOURS;
  const pollIntervalMs = Number.isFinite(Number(payload.pollIntervalMs))
    ? Math.max(500, Math.min(10000, Math.round(Number(payload.pollIntervalMs))))
    : DEFAULT_POLL_INTERVAL_MS;
  const seconds = Number.isFinite(Number(payload.seconds))
    ? Math.max(4, Math.min(15, Math.round(Number(payload.seconds))))
    : 5;
  const resolution = VALID_RESOLUTIONS.has(String(payload.resolution || '').trim())
    ? String(payload.resolution).trim()
    : DEFAULT_RESOLUTION;
  return {
    userDataDir: '动态分配账号槽位（执行侧）',
    channel: String(payload.channel || DEFAULT_CHANNEL).trim().toLowerCase() || DEFAULT_CHANNEL,
    provider: String(payload.provider || DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER,
    aspectRatio,
    humanSpeedPreset,
    modelName:
      String(payload.modelName || resolveDefaultModelName(payload.channel || DEFAULT_CHANNEL)).trim()
      || resolveDefaultModelName(payload.channel || DEFAULT_CHANNEL),
    seconds,
    resolution,
    taskType,
    priority,
    expireHours,
    pollIntervalMs,
    requiredAccountId: payload.requiredAccountId
      ? String(payload.requiredAccountId).trim()
      : payload.required_account_id
        ? String(payload.required_account_id).trim()
        : '',
  };
}

function getCurrentSettings() {
  const stored = readSettings();
  const merged = {
    ...((stored && stored.chatGeneration) || {}),
    ...(runtime.settingsOverride || {}),
  };
  return normalizeSettings(merged);
}

function persistSettings(next) {
  const normalized = normalizeSettings(next);
  runtime.settingsOverride = normalized;
  writeSettings({ chatGeneration: normalized });
  markStateDirty();
  return normalized;
}

function inspectSettings(settings) {
  const device = deviceState.readDeviceState();
  const targetMachineId = resolveTargetMachineId(settings, device);
  return {
    autoGenRootExists: true,
    userDataDirExists: true,
    outDir: taskStorage.sharedTaskRoot(),
    userDataSuggestions: [taskStorage.sharedTaskRoot()],
    serverUrl: device.serverUrl || null,
    machineId: device.machineId || null,
    executorService: FIXED_EXECUTOR_SERVICE,
    targetMachineId,
    activated: Boolean(device.machineId && device.token),
  };
}

function resolveTargetMachineId(settings, device) {
  const fixed = String(
    process.env.FLOW_AUTO_GEN_MACHINE_ID || process.env.FLOW_TASK_TARGET_MACHINE_ID || '',
  ).trim();
  return fixed || null;
}

function pruneMessages() {
  if (runtime.messages.length <= MAX_MESSAGES) return;
  runtime.messages.splice(0, runtime.messages.length - MAX_MESSAGES);
  cleanupAssets();
}

function cleanupAssets() {
  const used = new Set();
  for (const msg of runtime.messages) {
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    for (const attachment of attachments) {
      if (attachment && attachment.id) used.add(String(attachment.id));
    }
  }
  for (const assetId of runtime.assets.keys()) {
    if (!used.has(assetId)) runtime.assets.delete(assetId);
  }
}

function pushMessage(message) {
  runtime.messages.push(message);
  pruneMessages();
  markStateDirty();
  return message;
}

function findMessage(messageId) {
  return runtime.messages.find((message) => message.id === messageId) || null;
}

function updateMessage(messageId, patch) {
  const index = runtime.messages.findIndex((message) => message.id === messageId);
  if (index === -1) return null;
  const current = runtime.messages[index];
  runtime.messages[index] = {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  };
  markStateDirty();
  return runtime.messages[index];
}

function storeJob(jobId, job) {
  runtime.jobs.set(String(jobId), job);
  markStateDirty();
  return job;
}

function deleteJob(jobId) {
  const removed = runtime.jobs.delete(String(jobId));
  if (removed) markStateDirty();
  return removed;
}

function compareIsoValues(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function messageRoleOrder(message) {
  const role = String(message?.role || '').trim().toLowerCase();
  if (role === 'user') return 0;
  if (role === 'assistant') return 1;
  return 2;
}

function sortMessagesByCreatedAt(messages) {
  return messages.sort((left, right) => {
    const byCreatedAt = compareIsoValues(left?.createdAt, right?.createdAt);
    if (byCreatedAt !== 0) return byCreatedAt;
    const leftSortOrder = Number(left?.sortOrder);
    const rightSortOrder = Number(right?.sortOrder);
    if (Number.isFinite(leftSortOrder) && Number.isFinite(rightSortOrder) && leftSortOrder !== rightSortOrder) {
      return leftSortOrder - rightSortOrder;
    }
    if (left?.jobId && right?.jobId && String(left.jobId) === String(right.jobId)) {
      const byRole = messageRoleOrder(left) - messageRoleOrder(right);
      if (byRole !== 0) return byRole;
    }
    return compareIsoValues(left?.id, right?.id);
  });
}

function taskHasReferenceAsset(task) {
  const inputPayload = task?.inputPayload && typeof task.inputPayload === 'object' ? task.inputPayload : {};
  return Boolean(inputPayload.referenceAssetId)
    || (Array.isArray(inputPayload.referenceAssetIds) && inputPayload.referenceAssetIds.length > 0);
}

function buildRestoredReferenceImage(task) {
  if (!taskHasReferenceAsset(task)) return null;
  return {
    name: '已使用参考图',
    dataUrl: null,
  };
}

function buildRestoredJobSettings(task, batch) {
  const inputPayload = task?.inputPayload && typeof task.inputPayload === 'object' ? task.inputPayload : {};
  const params = inputPayload.params && typeof inputPayload.params === 'object' ? inputPayload.params : {};
  const extraBody = params.extra_body && typeof params.extra_body === 'object' ? params.extra_body : {};
  return normalizeSettings({
    ...getCurrentSettings(),
    taskType: task?.taskType,
    modelName: inputPayload.modelName || params.channel_options?.model || params.model,
    aspectRatio: inputPayload.aspectRatio,
    seconds: params.seconds,
    resolution: extraBody.resolution,
    humanSpeedPreset: inputPayload.humanSpeedPreset,
    requiredAccountId: task?.requiredAccountProfile || '',
    priority: task?.priority || batch?.priority,
  });
}

function collectExistingRemoteKeys() {
  const batchIds = new Set();
  const taskIds = new Set();
  const jobIds = new Set();
  for (const message of runtime.messages) {
    if (message?.jobId) jobIds.add(String(message.jobId));
    const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
    if (meta.batchId) batchIds.add(String(meta.batchId));
    if (meta.taskId) taskIds.add(String(meta.taskId));
  }
  for (const job of runtime.jobs.values()) {
    if (job?.id) jobIds.add(String(job.id));
    if (job?.batchId) batchIds.add(String(job.batchId));
    if (job?.taskId) taskIds.add(String(job.taskId));
  }
  return { batchIds, taskIds, jobIds };
}

function buildRestoredConversation(batch, task, { sortOrderBase = 0 } = {}) {
  const prompt = String(task?.prompt || '').trim();
  if (!prompt) return null;
  const createdAt = task?.createdAt || batch?.createdAt || nowIso();
  const jobId = String(batch?.idempotencyKey || batch?.id || task?.id || makeId('job')).trim();
  const referenceImage = buildRestoredReferenceImage(task);
  const settings = buildRestoredJobSettings(task, batch);
  const assistantMessageId = `restored_assistant_${String(task?.id || jobId)}`;
  const userMessage = {
    id: `restored_user_${String(task?.id || jobId)}`,
    role: 'user',
    text: prompt,
    createdAt,
    sortOrder: sortOrderBase,
    jobId,
    attachments: [],
    meta: {
      prompt,
      referenceName: referenceImage?.name || null,
      aspectRatio: settings.aspectRatio,
    },
  };
  const assistantMessage = {
    id: assistantMessageId,
    role: 'assistant',
    text: '正在同步远端任务状态…',
    createdAt,
    sortOrder: sortOrderBase + 1,
    jobId,
    status: remoteStatusToLocal(task?.status || batch?.status),
    attachments: [],
    logs: [],
    meta: {
      prompt,
      aspectRatio: settings.aspectRatio,
      referenceName: referenceImage?.name || null,
      batchId: batch?.id || null,
      taskId: task?.id || null,
      machineId: batch?.targetMachineId || task?.targetMachineId || null,
      requiredAccountId: task?.requiredAccountProfile || null,
    },
  };
  const job = {
    id: jobId,
    prompt,
    createdAt,
    assistantMessageId,
    machineId: batch?.createdByMachineId || task?.createdByMachineId || null,
    targetMachineId: batch?.targetMachineId || task?.targetMachineId || null,
    referenceImage,
    settings,
    logs: [],
    batchId: batch?.id || null,
    taskId: task?.id || null,
    remoteStatus: task?.status || batch?.status || 'queued',
    remoteBatchStatus: batch?.status || 'queued',
    lastObservedStatus: null,
    lastClaimedBySlotId: null,
    lastRequiredAccount: null,
    lastResolvedAccount: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastRunId: null,
    lastRunStatus: null,
    lastArtifactCount: 0,
    isPolling: false,
  };
  return { userMessage, assistantMessage, job };
}

function mergeMessages(messages) {
  const next = Array.isArray(messages) ? messages.filter(Boolean) : [];
  runtime.messages = sortMessagesByCreatedAt([...runtime.messages, ...next]).slice(-MAX_MESSAGES);
  cleanupAssets();
  markStateDirty();
}

function appendJobLog(job, line) {
  const text = String(line || '').trim();
  if (!text) return;
  const entry = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`;
  const next = Array.isArray(job.logs) ? job.logs.slice() : [];
  next.push(entry);
  if (next.length > MAX_LOG_LINES) next.splice(0, next.length - MAX_LOG_LINES);
  job.logs = next;
}

function setAssistantProgress(job, text, extra = {}) {
  const current = findMessage(job.assistantMessageId);
  if (!current) return;
  const meta = {
    ...(current.meta || {}),
    ...((extra && extra.meta) || {}),
  };
  updateMessage(job.assistantMessageId, {
    status: extra.status || current.status || 'running',
    text: text || current.text,
    logs: extra.logs || job.logs || current.logs || [],
    attachments: extra.attachments || current.attachments || [],
    meta,
  });
}

function registerLocalAsset(asset) {
  if (!asset || !asset.id) return null;
  const assetId = String(asset.id);
  runtime.assets.set(assetId, {
    id: assetId,
    path: asset.path || null,
    mimeType: asset.mimeType,
    name: asset.name,
    size: asset.size,
    dataUrl: asset.dataUrl || null,
    remoteUrl: asset.remoteUrl || null,
    objectKey: asset.objectKey || null,
    transport: asset.transport || (asset.remoteUrl || asset.objectKey ? 'oss' : 'local'),
  });
  return runtime.assets.get(assetId);
}

function isTerminalRemoteStatus(status) {
  return ['succeeded', 'failed', 'cancelled', 'expired'].includes(String(status || ''));
}

function remoteStatusToLocal(status) {
  const value = String(status || '').trim();
  if (value === 'succeeded') return 'done';
  if (value === 'running' || value === 'cancel_requested') return 'running';
  if (value === 'queued') return 'queued';
  return 'failed';
}

function compactErrorText(value, maxLength = 2000) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function parseJsonObjectFromText(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const candidates = [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // keep trying narrower candidates
    }
  }
  return null;
}

function stripErrorPrefix(value) {
  return String(value || '')
    .trim()
    .replace(/^[A-Za-z_][\w.]*Error:\s*/u, '')
    .trim();
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeErrorDetails(value) {
  if (value == null) return { code: '', message: '' };
  if (typeof value === 'string') {
    const parsed = parseJsonObjectFromText(value);
    if (parsed) {
      const details = normalizeErrorDetails(parsed);
      if (details.message || details.code) return details;
    }
    return { code: '', message: stripErrorPrefix(value) };
  }
  if (typeof value !== 'object') {
    return { code: '', message: String(value || '').trim() };
  }

  const error = value.error && typeof value.error === 'object' ? value.error : null;
  const data = value.data && typeof value.data === 'object' ? value.data : null;
  const dataError = data?.error && typeof data.error === 'object' ? data.error : null;
  const outputError = value.outputSummary?.error || value.output_summary?.error || null;
  const nested =
    normalizeErrorDetails(error || dataError || outputError || value.cause || null);
  const code = firstString(
    value.code,
    value.errorCode,
    value.error_code,
    nested.code,
    error?.code,
    dataError?.code,
    value.type,
    error?.type,
    dataError?.type,
  );
  const message = firstString(
    value.message,
    value.errorMessage,
    value.error_message,
    value.detail,
    value.description,
    nested.message,
    typeof value.error === 'string' ? value.error : '',
    typeof data?.error === 'string' ? data.error : '',
  );
  return { code, message: stripErrorPrefix(message) };
}

function extractRemoteErrorDetails(...values) {
  for (const value of values) {
    const details = normalizeErrorDetails(value);
    if (details.message || details.code) {
      return {
        code: compactErrorText(details.code, 256),
        message: compactErrorText(details.message || details.code),
      };
    }
  }
  return { code: '', message: '' };
}

function formatRemoteErrorMessage(details, fallback = '生成失败，请稍后重试。') {
  const message = compactErrorText(details?.message || fallback);
  const code = compactErrorText(details?.code || '', 256);
  if (code && message && !message.includes(code)) return `${message}\n错误码：${code}`;
  return message || code || fallback;
}

function summarizeTask(task, batch, errorDetails = null) {
  const status = String(task?.status || batch?.status || 'queued');
  if (status === 'queued') return '任务已提交，正在排队。';
  if (status === 'running') return '任务执行中，请稍候。';
  if (status === 'cancel_requested') return '任务正在取消，请稍候。';
  if (status === 'succeeded') {
    const count = Array.isArray(task?.artifacts) ? task.artifacts.length : 0;
    return count ? `已完成，返回 ${count} 个结果。` : '任务已完成，但当前页暂无可展示结果。';
  }
  if (status === 'cancelled') return '任务已取消。';
  if (status === 'expired') {
    return formatRemoteErrorMessage(errorDetails, '任务已过期，请重新提交。');
  }
  return formatRemoteErrorMessage(errorDetails, '生成失败，请稍后重试。');
}

function assetRecordFromRemote(asset) {
  if (!asset || typeof asset !== 'object') return null;
  const metadata = asset.metadata && typeof asset.metadata === 'object' ? asset.metadata : {};
  const remoteUrl = String(metadata.publicUrl || '').trim();
  const transport = String(metadata.transport || '').trim().toLowerCase();
  const isOssAsset = transport === 'oss' || remoteUrl || Boolean(String(metadata.ossObjectKey || '').trim());
  if (isOssAsset) {
    const objectKey = String(metadata.ossObjectKey || asset.relativePath || '').trim();
    const record = {
      id: String(asset.id || makeId('asset')),
      name: String(asset.fileName || path.basename(objectKey || '') || 'result'),
      path: null,
      mimeType: asset.mimeType || mimeFromPath(asset.fileName || objectKey),
      size: Number(asset.sizeBytes || 0) || 0,
      quality: metadata.quality || null,
      source: metadata.source || null,
      remoteUrl: remoteUrl || null,
      objectKey: objectKey || null,
      transport: 'oss',
    };
    registerLocalAsset(record);
    return record;
  }
  try {
    const absolutePath = taskStorage.resolveAssetPath({
      storageRootKey: asset.storageRootKey,
      relativePath: asset.relativePath,
    });
    const stat = fs.existsSync(absolutePath) ? fs.statSync(absolutePath) : null;
    const record = {
      id: String(asset.id || makeId('asset')),
      name: String(asset.fileName || path.basename(absolutePath) || 'result'),
      path: absolutePath,
      mimeType: asset.mimeType || mimeFromPath(absolutePath),
      size: stat ? stat.size : Number(asset.sizeBytes || 0) || 0,
      quality: asset.metadata && typeof asset.metadata === 'object' ? asset.metadata.quality || null : null,
      source: asset.metadata && typeof asset.metadata === 'object' ? asset.metadata.source || null : null,
    };
    registerLocalAsset(record);
    return record;
  } catch {
    return null;
  }
}

function buildAttachmentsFromTask(task) {
  const out = [];
  for (const asset of Array.isArray(task?.artifacts) ? task.artifacts : []) {
    const record = assetRecordFromRemote(asset);
    if (record) out.push(record);
  }
  return out;
}

function refreshJobMessage(job, batch) {
  const tasks = Array.isArray(batch?.tasks) ? batch.tasks : [];
  const task = tasks[0] || null;
  if (!task) return;
  const runs = Array.isArray(task?.runs) ? task.runs : [];
  const latestRun = runs.length ? runs[runs.length - 1] : null;
  const artifactCount = Array.isArray(task?.artifacts) ? task.artifacts.length : 0;
  const effectiveSlotId = task.claimedBySlotId || latestRun?.slotId || null;
  const effectiveAccountProfile =
    latestRun?.accountProfile || task.requiredAccountProfile || job.settings.requiredAccountId || null;
  const extractedError = extractRemoteErrorDetails(
    task.errorMessage,
    latestRun?.errorMessage,
    task.resultPayload,
    latestRun?.outputSummary,
  );
  const effectiveErrorCode = extractedError.code || task.errorCode || latestRun?.errorCode || null;
  const effectiveErrorMessage = extractedError.message || null;

  job.batchId = batch.id;
  job.taskId = task.id;
  job.remoteStatus = task.status;
  job.remoteBatchStatus = batch.status;

  const attachments = isTerminalRemoteStatus(task.status) ? buildAttachmentsFromTask(task) : [];
  const text = summarizeTask(task, batch, {
    code: effectiveErrorCode,
    message: effectiveErrorMessage,
  });
  const meta = {
    prompt: job.prompt,
    aspectRatio: job.settings.aspectRatio,
    referenceName: referenceNamesLabel(job.referenceImages) || job.referenceImage?.name || null,
    referenceCount: Array.isArray(job.referenceImages) ? job.referenceImages.length : (job.referenceImage ? 1 : 0),
    batchId: batch.id,
    taskId: task.id,
    taskStatus: task.status,
    batchStatus: batch.status,
    machineId: batch.targetMachineId || job.targetMachineId || job.machineId || null,
    requiredAccountId: job.settings.requiredAccountId || null,
    accountProfile: effectiveAccountProfile,
    claimedBySlotId: effectiveSlotId,
    currentTaskRunId: task.currentTaskRunId || latestRun?.id || null,
    latestRunStatus: latestRun?.status || null,
    latestRunStartedAt: latestRun?.startedAt || null,
    latestRunFinishedAt: latestRun?.finishedAt || null,
    runCount: runs.length,
    artifactCount,
    errorCode: effectiveErrorCode,
    errorMessage: effectiveErrorMessage,
    executorService: FIXED_EXECUTOR_SERVICE,
  };

  if (job.lastObservedStatus !== task.status) {
    appendJobLog(job, `状态更新：${task.status}`);
    job.lastObservedStatus = task.status;
  }
  if (effectiveSlotId && job.lastClaimedBySlotId !== effectiveSlotId) {
    appendJobLog(job, `已分配 slot #${effectiveSlotId}`);
    job.lastClaimedBySlotId = effectiveSlotId;
  }
  if (task.requiredAccountProfile && job.lastRequiredAccount !== task.requiredAccountProfile) {
    appendJobLog(job, `指定账号：${task.requiredAccountProfile}`);
    job.lastRequiredAccount = task.requiredAccountProfile;
  }
  if (effectiveAccountProfile && job.lastResolvedAccount !== effectiveAccountProfile) {
    appendJobLog(job, `实际账号：${effectiveAccountProfile}`);
    job.lastResolvedAccount = effectiveAccountProfile;
  }
  if (latestRun?.id && job.lastRunId !== latestRun.id) {
    appendJobLog(job, `执行 run #${latestRun.id}`);
    job.lastRunId = latestRun.id;
  }
  if (latestRun?.status && job.lastRunStatus !== latestRun.status) {
    appendJobLog(job, `执行状态：${latestRun.status}`);
    job.lastRunStatus = latestRun.status;
  }
  if (effectiveErrorCode && job.lastErrorCode !== effectiveErrorCode) {
    appendJobLog(job, `错误码：${effectiveErrorCode}`);
    job.lastErrorCode = effectiveErrorCode;
  }
  if (effectiveErrorMessage && job.lastErrorMessage !== effectiveErrorMessage) {
    appendJobLog(job, `失败原因：${effectiveErrorMessage}`);
    job.lastErrorMessage = effectiveErrorMessage;
  }
  if (artifactCount && job.lastArtifactCount !== artifactCount) {
    appendJobLog(job, `已返回 ${artifactCount} 个结果`);
    job.lastArtifactCount = artifactCount;
  }

  setAssistantProgress(job, text, {
    status: remoteStatusToLocal(task.status),
    logs: job.logs || [],
    attachments,
    meta,
  });
}

function parseReferenceImage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const name = String(payload.name || '').trim() || 'reference.png';
  const dataUrl = String(payload.dataUrl || '').trim();
  if (!dataUrl) return null;
  return { name, dataUrl };
}

function parseReferenceImages(payload) {
  const items = Array.isArray(payload?.referenceImages)
    ? payload.referenceImages
    : payload?.referenceImage
      ? [payload.referenceImage]
      : [];
  const parsed = [];
  const seen = new Set();
  for (const item of items) {
    const image = parseReferenceImage(item);
    if (!image) continue;
    const key = `${image.name}\n${image.dataUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push(image);
    if (parsed.length >= MAX_SEEDANCE_REFERENCE_IMAGES) break;
  }
  return parsed;
}

function referenceNamesLabel(referenceImages) {
  const images = Array.isArray(referenceImages) ? referenceImages : [];
  if (!images.length) return null;
  if (images.length === 1) return images[0].name || 'reference.png';
  const firstName = images[0].name || 'reference.png';
  return `${firstName} 等 ${images.length} 张`;
}

function writeReferenceImage({ machineId, jobId, referenceImage }) {
  if (!referenceImage) return null;
  const match = String(referenceImage.dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('参考图格式不正确');
  const mimeType = match[1];
  const base64Data = match[2];
  const ext = path.extname(referenceImage.name) || mimeToExtension(mimeType);
  const fileName = sanitizeFilename(
    `${path.basename(referenceImage.name, path.extname(referenceImage.name)) || 'reference'}${ext.startsWith('.') ? ext : `.${ext}`}`,
  );
  const assetId = makeId('input');
  const location = taskStorage.buildSubmitAssetLocation({
    machineId,
    assetId: `${jobId}_${assetId}`,
    fileName,
  });
  fs.writeFileSync(location.absolutePath, Buffer.from(base64Data, 'base64'));
  return {
    assetId,
    location,
    mimeType,
    fileName,
    sizeBytes: fs.statSync(location.absolutePath).size,
  };
}

async function registerReferenceAsset(job) {
  if (!job.referenceImage) return null;
  const written = writeReferenceImage({
    machineId: job.machineId,
    jobId: job.id,
    referenceImage: job.referenceImage,
  });
  let relativePath = written.location.relativePath;
  let remoteUrl = null;
  let objectKey = null;
  const metadata = {
    source: 'flow_multi_account_chat',
    machineId: job.machineId,
    jobId: job.id,
    referenceName: job.referenceImage.name,
  };
  if (ossBridge.isOssTransportEnabled()) {
    objectKey = ossBridge.buildObjectKey({
      storageRootKey: written.location.storageRootKey,
      relativePath: written.location.relativePath,
    });
    const upload = await ossBridge.uploadFile({
      localPath: written.location.absolutePath,
      objectKey,
      contentType: written.mimeType,
    });
    remoteUrl = String(upload?.publicUrl || '').trim() || null;
    relativePath = String(upload?.objectKey || objectKey).trim() || objectKey;
    metadata.transport = 'oss';
    metadata.ossObjectKey = relativePath;
    metadata.publicUrl = remoteUrl;
  }
  const response = await taskClient.registerAsset({
    assetKind: 'input_reference',
    storageRootKey: written.location.storageRootKey,
    relativePath,
    fileName: written.fileName,
    mimeType: written.mimeType,
    sizeBytes: written.sizeBytes,
    metadata,
  });
  registerLocalAsset({
    id: response?.asset?.id || written.assetId,
    path: written.location.absolutePath,
    mimeType: written.mimeType,
    name: written.fileName,
    size: written.sizeBytes,
    dataUrl: job.referenceImage.dataUrl,
    remoteUrl,
    objectKey: remoteUrl ? (objectKey || relativePath) : null,
    transport: remoteUrl ? 'oss' : 'local',
  });
  return response?.asset || null;
}

async function registerReferenceAssets(job) {
  const images = Array.isArray(job.referenceImages)
    ? job.referenceImages.slice(0, MAX_SEEDANCE_REFERENCE_IMAGES)
    : [];
  if (!images.length) return [];
  const assets = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const asset = await registerReferenceAsset({
      ...job,
      referenceImage: image,
    });
    if (asset) {
      assets.push(asset);
      appendJobLog(job, `参考图 ${index + 1}/${images.length} 已登记：${asset.id || 'unknown'}`);
    }
  }
  return assets;
}

async function submitRemoteJob(job) {
  appendJobLog(job, '开始提交到远端任务队列');
  setAssistantProgress(job, '正在写入任务并登记输入资源…', {
    status: 'running',
    logs: job.logs || [],
  });

  const referenceAssets = await registerReferenceAssets(job);
  const referenceAsset = referenceAssets[0] || null;
  const referenceImageUrls = referenceAssets
    .map((asset) => String(asset?.metadata?.publicUrl || '').trim())
    .filter(Boolean);

  const expireAt = new Date(Date.now() + job.settings.expireHours * 60 * 60 * 1000).toISOString();
  const isSeedance = String(job.settings.channel || '').trim().toLowerCase() === 'seedance';
  const response = await taskClient.createTaskBatch({
    idempotencyKey: job.id,
    targetMachineId: job.targetMachineId,
    priority: job.settings.priority,
    expireAt,
    metadata: {
      source: 'flow_multi_account_chat',
      promptPreview: job.prompt.slice(0, 80),
      submittedAt: job.createdAt,
      submitMachineId: job.machineId,
      targetMachineId: job.targetMachineId,
    },
    tasks: [
      {
        channel: job.settings.channel,
        provider: job.settings.provider,
        taskType: job.settings.taskType,
        prompt: job.prompt,
        referenceAssetId: referenceAsset ? referenceAsset.id : null,
        referenceAssetIds: referenceAssets.map((asset) => asset.id).filter(Boolean),
        modelName: job.settings.modelName,
        aspectRatio: job.settings.aspectRatio,
        humanSpeedPreset: job.settings.humanSpeedPreset,
        required_account_id: job.settings.requiredAccountId || null,
        outputSettings: {
          download: true,
        },
        taskSettings: {
          source: 'flow_multi_account_chat',
          referenceAssetIds: referenceAssets.map((asset) => asset.id).filter(Boolean),
        },
        operation: isSeedance ? 'video.generate' : 'flow.run',
        inputPayload: isSeedance
          ? {
              channel: job.settings.channel,
              provider: job.settings.provider,
              operation: 'video.generate',
              referenceAssetId: referenceAsset ? referenceAsset.id : null,
              referenceAssetIds: referenceAssets.map((asset) => asset.id).filter(Boolean),
              params: {
                prompt: job.prompt,
                size: job.settings.aspectRatio === 'IMAGE_ASPECT_RATIO_LANDSCAPE'
                  ? '16:9'
                  : job.settings.aspectRatio === 'IMAGE_ASPECT_RATIO_SQUARE'
                    ? '1:1'
                    : job.settings.aspectRatio === 'IMAGE_ASPECT_RATIO_3_4'
                      ? '3:4'
                      : job.settings.aspectRatio === 'IMAGE_ASPECT_RATIO_4_3'
                        ? '4:3'
                    : '9:16',
                seconds: Number(job.settings.seconds || 5) || 5,
                channel_options: {
                  model: job.settings.modelName || 'dreamina-seedance-2-0-fast-260128',
                },
                extra_body: {
                  resolution: job.settings.resolution || '720p',
                  ...(referenceImageUrls.length
                    ? { images: referenceImageUrls }
                    : {}),
                },
              },
            }
          : undefined,
      },
    ],
  });
  const batch = response && response.batch ? response.batch : null;
  if (!batch) throw new Error('任务提交失败：服务端未返回 batch');
  appendJobLog(job, `批次已创建：${batch.id}`);
  refreshJobMessage(job, batch);
  return batch;
}

async function pollRemoteJob(job) {
  let failures = 0;
  while (runtime.jobs.has(job.id)) {
    try {
      const response = await taskClient.getTaskBatch(job.batchId);
      const batch = response && response.batch ? response.batch : null;
      if (!batch) throw new Error('任务状态查询失败：batch 缺失');
      failures = 0;
      refreshJobMessage(job, batch);
      const task = Array.isArray(batch.tasks) ? batch.tasks[0] : null;
      if (task && isTerminalRemoteStatus(task.status)) return;
    } catch (err) {
      failures += 1;
      appendJobLog(job, `轮询失败：${err && err.message ? err.message : String(err)}`);
      setAssistantProgress(job, failures >= 3 ? '状态同步异常，稍后会继续自动重试。' : '正在同步任务状态…', {
        status: findMessage(job.assistantMessageId)?.status || 'running',
        logs: job.logs || [],
      });
      if (failures >= 20) {
        throw new Error(err && err.message ? err.message : '任务状态同步失败');
      }
      await sleep(Math.min(job.settings.pollIntervalMs * failures, 5000));
      continue;
    }
    await sleep(job.settings.pollIntervalMs);
  }
}

async function watchRemoteJob(job, { submit = false } = {}) {
  try {
    if (submit) {
      const batch = await submitRemoteJob(job);
      job.batchId = batch.id;
    } else if (!job.batchId) {
      throw new Error('任务恢复失败：缺少 batchId');
    }
    await pollRemoteJob(job);
  } catch (err) {
    const errorDetails = extractRemoteErrorDetails(err?.message, err);
    const errorMessage = formatRemoteErrorMessage(errorDetails, '任务提交失败');
    appendJobLog(job, `提交或同步失败：${errorMessage}`);
    setAssistantProgress(job, errorMessage, {
      status: 'failed',
      logs: job.logs || [],
      meta: {
        prompt: job.prompt,
        aspectRatio: job.settings.aspectRatio,
        referenceName: referenceNamesLabel(job.referenceImages) || job.referenceImage?.name || null,
        referenceCount: Array.isArray(job.referenceImages) ? job.referenceImages.length : (job.referenceImage ? 1 : 0),
        batchId: job.batchId || null,
        errorCode: errorDetails.code || null,
        errorMessage,
      },
    });
  } finally {
    job.isPolling = false;
    deleteJob(job.id);
  }
}

function startRemoteJob(job, { submit = false } = {}) {
  if (!job || job.isPolling) return;
  job.isPolling = true;
  watchRemoteJob(job, { submit }).catch(() => {});
}

async function ensureHydrated() {
  if (runtime.hydrated) return;
  if (runtime.hydrationPromise) {
    await runtime.hydrationPromise;
    return;
  }
  runtime.hydrationPromise = (async () => {
    const device = deviceState.readDeviceState();
    if (!device.machineId || !device.token) {
      return;
    }
    const response = await taskClient.listTaskBatches(RESTORE_BATCH_LIMIT);
    const batches = Array.isArray(response?.batches) ? response.batches.slice() : [];
    const existingKeys = collectExistingRemoteKeys();
    const restoredConversations = [];
    let restoredSortOrder = 0;
    for (const batch of batches.sort((left, right) => compareIsoValues(left?.createdAt, right?.createdAt))) {
      const tasks = Array.isArray(batch?.tasks) ? batch.tasks : [];
      for (const task of tasks) {
        const taskId = String(task?.id || '').trim();
        const batchId = String(batch?.id || '').trim();
        const jobId = String(batch?.idempotencyKey || batchId || taskId || '').trim();
        if ((taskId && existingKeys.taskIds.has(taskId))
          || (batchId && existingKeys.batchIds.has(batchId))
          || (jobId && existingKeys.jobIds.has(jobId))) {
          continue;
        }
        const conversation = buildRestoredConversation(batch, task, {
          sortOrderBase: restoredSortOrder,
        });
        if (!conversation) continue;
        restoredConversations.push({ batch, task, ...conversation });
        restoredSortOrder += 2;
      }
    }
    mergeMessages(
      restoredConversations.flatMap((entry) => [entry.userMessage, entry.assistantMessage]),
    );
    for (const entry of restoredConversations) {
      refreshJobMessage(entry.job, entry.batch);
      if (isTerminalRemoteStatus(entry.task?.status)) continue;
      storeJob(entry.job.id, entry.job);
      startRemoteJob(entry.job);
    }
    runtime.hydrated = true;
    runtime.lastHydratedAt = nowIso();
    markStateDirty();
  })();
  try {
    await runtime.hydrationPromise;
  } finally {
    runtime.hydrationPromise = null;
  }
}

async function getState() {
  try {
    await ensureHydrated();
  } catch (err) {
    console.warn(`[chatGeneration] hydrate failed: ${err?.message || err}`);
  }
  const settings = getCurrentSettings();
  const device = deviceState.readDeviceState();
  const stateCacheKey = JSON.stringify({
    revision: runtime.stateRevision,
    settings,
    machineId: device.machineId || null,
    token: device.token || null,
    serverUrl: device.serverUrl || null,
  });
  if (runtime.stateCache && runtime.stateCacheKey === stateCacheKey) {
    return runtime.stateCache;
  }
  const jobs = Array.from(runtime.jobs.values()).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const pendingJobs = jobs.filter((job) => !isTerminalRemoteStatus(job.remoteStatus));
  const active = pendingJobs.find((job) => String(job.remoteStatus || '') === 'running') || pendingJobs[0] || null;
  const state = {
    revision: runtime.stateRevision,
    settings,
    inspection: inspectSettings(settings),
    activeJobId: active ? active.id : null,
    queue: pendingJobs
      .filter((job) => !active || job.id !== active.id)
      .map((job) => ({
        id: job.id,
        prompt: job.prompt,
        createdAt: job.createdAt,
      })),
    busy: pendingJobs.length > 0,
    messages: runtime.messages,
  };
  runtime.stateCache = state;
  runtime.stateCacheKey = stateCacheKey;
  return state;
}

function updateSettings(patch) {
  const next = persistSettings({
    ...getCurrentSettings(),
    ...(patch && typeof patch === 'object' ? patch : {}),
  });
  return {
    success: true,
    settings: next,
    inspection: inspectSettings(next),
  };
}

async function sendMessage(payload) {
  try {
    await ensureHydrated();
  } catch (err) {
    console.warn(`[chatGeneration] hydrate before send failed: ${err?.message || err}`);
  }
  const prompt = String(payload?.prompt || '').trim();
  if (!prompt) throw new Error('请输入提示词');

  const settings = persistSettings({
    ...getCurrentSettings(),
    ...(payload?.settings && typeof payload.settings === 'object' ? payload.settings : {}),
    ...(payload && typeof payload === 'object'
      ? {
          requiredAccountId: payload.requiredAccountId || payload.required_account_id || '',
          taskType: payload.taskType || payload.task_type || undefined,
        }
      : {}),
  });
  const device = deviceState.readDeviceState();
  if (!device.machineId || !device.token) throw new Error('设备未激活，无法提交任务');
  const targetMachineId = resolveTargetMachineId(settings, device);

  const createdAt = nowIso();
  const jobId = makeId('job');
  const userMessageId = makeId('msg');
  const assistantMessageId = makeId('msg');
  const referenceImages = parseReferenceImages(payload);
  const referenceImage = referenceImages[0] || null;
  const referenceName = referenceNamesLabel(referenceImages);

  pushMessage({
    id: userMessageId,
    role: 'user',
    text: prompt,
    createdAt,
    jobId,
    attachments: [],
    meta: {
      prompt,
      referenceName,
      referenceCount: referenceImages.length,
      aspectRatio: settings.aspectRatio,
    },
  });

  pushMessage({
    id: assistantMessageId,
    role: 'assistant',
    text: '正在提交任务到共享队列…',
    createdAt,
    jobId,
    status: 'running',
    attachments: [],
    logs: [],
    meta: {
      prompt,
      aspectRatio: settings.aspectRatio,
      referenceName,
      referenceCount: referenceImages.length,
      machineId: targetMachineId,
      requiredAccountId: settings.requiredAccountId || null,
    },
  });

  const job = {
    id: jobId,
    prompt,
    createdAt,
    assistantMessageId,
    machineId: device.machineId,
    targetMachineId,
    referenceImage,
    referenceImages,
    settings,
    logs: [],
    batchId: null,
    taskId: null,
    remoteStatus: 'queued',
    remoteBatchStatus: 'queued',
    lastObservedStatus: null,
    lastClaimedBySlotId: null,
    lastRequiredAccount: null,
    lastResolvedAccount: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastRunId: null,
    lastRunStatus: null,
    lastArtifactCount: 0,
    isPolling: false,
  };
  storeJob(jobId, job);
  startRemoteJob(job, { submit: true });

  return {
    success: true,
    jobId,
  };
}

async function listTargetMachines() {
  const device = deviceState.readDeviceState();
  const settings = getCurrentSettings();
  const submitMachineId = device.machineId || null;
  const effectiveTargetMachineId = resolveTargetMachineId(settings, device);
  if (!device.token) {
    return {
      activated: false,
      submitMachineId,
      effectiveTargetMachineId,
      executorService: FIXED_EXECUTOR_SERVICE,
      machines: [],
    };
  }
  const response = await taskClient.listExecutorMachines();
  return {
    activated: true,
    submitMachineId: response?.submitMachineId || submitMachineId,
    effectiveTargetMachineId,
    executorService: FIXED_EXECUTOR_SERVICE,
    machines: Array.isArray(response?.machines) ? response.machines : [],
  };
}

async function listChannels() {
  const device = deviceState.readDeviceState();
  if (!device.token) {
    return {
      activated: false,
      channels: [],
    };
  }
  const response = await taskClient.listChannels();
  return {
    activated: true,
    version: response?.version || null,
    channels: Array.isArray(response?.channels) ? response.channels : [],
  };
}

function clearHistory() {
  if (runtime.jobs.size > 0) {
    throw new Error('有任务运行时不能清空聊天记录');
  }
  runtime.messages = [];
  runtime.assets.clear();
  runtime.hydrated = true;
  runtime.hydrationPromise = null;
  markStateDirty();
  return { success: true };
}

async function getAssetData(assetId) {
  const key = String(assetId || '').trim();
  if (!key) throw new Error('asset id required');
  const asset = runtime.assets.get(key);
  if (!asset) throw new Error('图片资源不存在或已失效');
  if (!asset.dataUrl) {
    if (asset.path && fs.existsSync(asset.path)) {
      const bytes = fs.readFileSync(asset.path);
      asset.dataUrl = `data:${asset.mimeType};base64,${bytes.toString('base64')}`;
    } else if (asset.remoteUrl) {
      asset.dataUrl = await ossBridge.fetchRemoteDataUrl({
        remoteUrl: asset.remoteUrl,
        mimeType: asset.mimeType,
      });
    } else {
      throw new Error('图片资源不存在或远端地址缺失');
    }
  }
  return {
    success: true,
    asset: {
      id: asset.id,
      name: asset.name,
      path: asset.path,
      mimeType: asset.mimeType,
      size: asset.size,
      dataUrl: asset.dataUrl,
      remoteUrl: asset.remoteUrl || null,
    },
  };
}

module.exports = {
  clearHistory,
  getAssetData,
  getState,
  listTargetMachines,
  listChannels,
  sendMessage,
  updateSettings,
};
