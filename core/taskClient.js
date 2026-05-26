const controlPlane = require('./controlPlane');
const deviceState = require('./deviceState');

function authHeaders() {
  const state = deviceState.readDeviceState();
  if (!state.token) throw new Error('设备未激活');
  return { Authorization: `Bearer ${state.token}` };
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...headers,
      },
      body,
      signal: controller.signal,
    });
    if (res.status === 401) {
      try {
        deviceState.writeDeviceState({ token: null, allowedProfiles: [] });
      } catch {
        // ignore
      }
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data && data.error ? data.error : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  } catch (err) {
    if (err && typeof err === 'object' && err.name === 'AbortError') {
      throw new Error('请求超时：请检查管理服务和数据库任务系统是否可用');
    }
    if (err instanceof TypeError) {
      const code = err?.cause?.code;
      if (code === 'ENOTFOUND') throw new Error('无法解析管理服务地址：请检查地址是否正确');
      if (code === 'ECONNREFUSED') throw new Error('连接被拒绝：管理服务未启动或端口不可达');
      if (code === 'ETIMEDOUT') throw new Error('连接超时：请检查网络或服务端状态');
      throw new Error('无法连接到管理服务：请检查服务地址、网络与防火墙');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function registerAsset(payload) {
  const base = controlPlane.getBaseUrl();
  return fetchJson(`${base}/v1/client/assets/register`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
    timeoutMs: 15000,
  });
}

async function createTaskBatch(payload) {
  const base = controlPlane.getBaseUrl();
  return fetchJson(`${base}/v1/client/task-batches`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
    timeoutMs: 15000,
  });
}

async function listExecutorMachines() {
  const base = controlPlane.getBaseUrl();
  return fetchJson(`${base}/v1/client/executor-machines`, {
    headers: authHeaders(),
    timeoutMs: 10000,
  });
}

async function listChannels() {
  const base = controlPlane.getBaseUrl();
  return fetchJson(`${base}/v1/client/channels`, {
    headers: authHeaders(),
    timeoutMs: 10000,
  });
}

async function getTaskBatch(batchId) {
  const base = controlPlane.getBaseUrl();
  return fetchJson(`${base}/v1/client/task-batches/${encodeURIComponent(String(batchId || '').trim())}`, {
    headers: authHeaders(),
    timeoutMs: 10000,
  });
}

async function listTaskBatches(limit = 20) {
  const base = controlPlane.getBaseUrl();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  return fetchJson(`${base}/v1/client/task-batches?limit=${safeLimit}`, {
    headers: authHeaders(),
    timeoutMs: 15000,
  });
}

async function getTask(taskId) {
  const base = controlPlane.getBaseUrl();
  return fetchJson(`${base}/v1/client/tasks/${encodeURIComponent(String(taskId || '').trim())}`, {
    headers: authHeaders(),
    timeoutMs: 10000,
  });
}

module.exports = {
  createTaskBatch,
  getTask,
  getTaskBatch,
  listTaskBatches,
  listChannels,
  listExecutorMachines,
  registerAsset,
};
