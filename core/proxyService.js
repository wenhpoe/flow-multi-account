const controlPlane = require('./controlPlane');
const deviceState = require('./deviceState');

function normalizeProxy(proxy) {
  if (!proxy) return null;
  if (typeof proxy === 'string') {
    const v = proxy.trim();
    if (!v) return null;
    if (/^(vless|hysteria2|vmess):\/\//i.test(v)) return null;
    // Support vendor format: "host:port:username:password"
    // (password may contain ':')
    if (!v.includes('://')) {
      const parts = v.split(':');
      if (parts.length >= 4) {
        const host = parts[0].trim();
        const port = Number(parts[1]);
        const username = parts[2];
        const password = parts.slice(3).join(':');
        if (host && Number.isFinite(port) && port > 0) {
          return { server: `http://${host}:${port}`, username, password };
        }
      }
    }
    return { server: (v.includes('://') ? v : `http://${v}`).replace(/\/+$/, '') };
  }
  if (typeof proxy === 'object') {
    if (typeof proxy.server === 'string' && proxy.server.trim()) {
      const out = { server: proxy.server.trim().replace(/\/+$/, '') };
      if (/^(vless|hysteria2):\/\//i.test(out.server)) return null;
      if (!out.server.includes('://')) out.server = `http://${out.server}`;
      out.server = out.server.replace(/\/+$/, '');
      if (typeof proxy.username === 'string') out.username = proxy.username;
      if (typeof proxy.password === 'string') out.password = proxy.password;
      if (typeof proxy.bypass === 'string') out.bypass = proxy.bypass;
      return out;
    }
  }
  return null;
}

function isNodeLink(link) {
  const s = String(link || '').trim();
  return s.startsWith('vless://') || s.startsWith('hysteria2://') || s.startsWith('vmess://');
}

function buildNodeLinkFromObject(node) {
  if (!node || typeof node !== 'object') return '';

  const typeRaw = String(node.type || node.protocol || '').trim().toLowerCase();
  const host = String(node.host || '').trim();
  const port = String(node.port || '').trim() || '443';
  const title = String(node.title || node.remark || '').trim();

  if (!host) return '';
  if (!/^\d{1,5}$/.test(port)) return '';

  if (typeRaw === 'vless') {
    const uuid = String(node.uuid || '').trim();
    if (!uuid) return '';

    const params = new URLSearchParams();
    // Most VLESS links include this; harmless if ignored.
    params.set('encryption', 'none');

    const tls = node.tls === true;
    if (tls) params.set('security', 'tls');

    const peer = String(node.peer || node.sni || node.serverName || '').trim();
    if (peer) params.set('sni', peer);

    const obfs = String(node.obfs || '').trim().toLowerCase();
    const obfsParam = String(node.obfsParam || '').trim();
    const path = String(node.path || '').trim();
    if (obfs === 'websocket' || obfs === 'ws') {
      params.set('type', 'ws');
      if (obfsParam) params.set('host', obfsParam);
      if (path) params.set('path', path);
    } else if (obfs === 'grpc') {
      params.set('type', 'grpc');
      if (obfsParam) params.set('serviceName', obfsParam);
    }

    const alpn = String(node.alpn || '').trim();
    if (alpn) params.set('alpn', alpn);

    const qs = params.toString();
    const hash = title ? `#${encodeURIComponent(title)}` : '';
    return `vless://${uuid}@${host}:${port}${qs ? `?${qs}` : ''}${hash}`;
  }

  if (typeRaw === 'hysteria2') {
    const password = String(node.password || '').trim();
    if (!password) return '';
    const params = new URLSearchParams();
    const peer = String(node.peer || node.sni || node.serverName || '').trim();
    if (peer) params.set('sni', peer);
    const alpn = String(node.alpn || '').trim();
    if (alpn) params.set('alpn', alpn);
    const qs = params.toString();
    const hash = title ? `#${encodeURIComponent(title)}` : '';
    return `hysteria2://${password}@${host}:${port}${qs ? `?${qs}` : ''}${hash}`;
  }

  return '';
}

function normalizeNode(node) {
  if (!node) return null;
  if (typeof node === 'string') {
    const fullLink = node.trim();
    if (!isNodeLink(fullLink)) return null;
    return { fullLink };
  }
  if (typeof node === 'object') {
    const fullLinkRaw = typeof node.fullLink === 'string' ? node.fullLink.trim() : '';
    const fullLink = isNodeLink(fullLinkRaw) ? fullLinkRaw : buildNodeLinkFromObject(node);
    if (!isNodeLink(fullLink)) return null;
    return { ...node, fullLink };
  }
  return null;
}

async function fetchJson(url, { timeoutMs = 2500 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const s = deviceState.readDeviceState();
    if (!s.token) throw new Error('设备未激活');
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', Authorization: `Bearer ${s.token}` }
      ,
      signal: controller.signal
    });
    // If token is invalidated server-side, reset local activation to force re-activation.
    if (res.status === 401) {
      try {
        deviceState.writeDeviceState({ token: null, allowedProfiles: [] });
      } catch {
        // ignore
      }
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data && data.error ? data.error : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  } catch (err) {
    if (err && typeof err === 'object' && err.name === 'AbortError') {
      throw new Error('请求超时：请检查管理服务地址是否正确、服务是否可访问');
    }
    if (err instanceof TypeError) {
      const code = err?.cause?.code;
      if (code === 'ENOTFOUND') throw new Error('无法解析管理服务地址：请检查地址是否输入正确');
      if (code === 'ECONNREFUSED') throw new Error('连接被拒绝：管理服务未启动或端口不可达');
      if (code === 'ETIMEDOUT') throw new Error('连接超时：请检查网络/防火墙或服务端状态');
      throw new Error('无法连接到管理服务：请检查服务地址、网络与防火墙');
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function getProxyForProfile(profileName) {
  const base = controlPlane.getBaseUrl();
  const url = `${base}/v1/client/proxy/${encodeURIComponent(String(profileName || '').trim())}`;
  const timeoutMs = process.env.PROXY_SERVICE_TIMEOUT_MS
    ? Number(process.env.PROXY_SERVICE_TIMEOUT_MS)
    : 2500;
  const ms = Number.isFinite(timeoutMs) ? timeoutMs : 2500;

  const data = await fetchJson(url, { timeoutMs: ms });
  const proxy = normalizeProxy(data && (data.proxy ?? data));
  const node = normalizeNode(data && data.node);
  return {
    proxy,
    node,
    source: data?.source || 'unknown',
    poolItemId: typeof data?.poolItemId === 'string' ? data.poolItemId : null,
    nodeId: typeof data?.nodeId === 'string' ? data.nodeId : null,
    policyNoAvailable: data?.policyNoAvailable === true,
    policyItems: typeof data?.policyItems === 'number' ? data.policyItems : null,
    policyEnabled: typeof data?.policyEnabled === 'number' ? data.policyEnabled : null,
    policyMissing: typeof data?.policyMissing === 'number' ? data.policyMissing : null,
    policyDisabled: typeof data?.policyDisabled === 'number' ? data.policyDisabled : null,
    policyUnusable: typeof data?.policyUnusable === 'number' ? data.policyUnusable : null,
  };
}

module.exports = {
  getProxyForProfile
};
