const http = require('http');
const net = require('net');

function isDebug() {
  return process.env.FMA_PROXY_DEBUG === '1' || process.env.FMA_PROXY_LOG_CREDENTIALS === '1';
}

function sanitizeHeaderValue(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\x20-\x7E]+/g, '?')
    .slice(0, 180);
}

function basicAuth(username, password) {
  const u = String(username ?? '');
  const p = String(password ?? '');
  const raw = `${u}:${p}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

function safeUrlForKey(server) {
  return String(server || '').trim().replace(/\/+$/, '');
}

function parseUpstream(server) {
  const raw = safeUrlForKey(server);
  if (!raw) throw new Error('代理地址为空');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('代理地址格式不正确');
  }
  if (u.protocol !== 'http:') throw new Error('当前仅支持 http 代理转发');
  const host = u.hostname;
  const port = u.port ? Number(u.port) : 80;
  if (!host || !Number.isFinite(port) || port <= 0) throw new Error('代理地址无效');
  return { host, port };
}

const forwarders = new Map();

async function getOrCreateForwarder({ server, username, password } = {}) {
  const upstreamKey = safeUrlForKey(server);
  const user = String(username ?? '');
  const pass = String(password ?? '');
  if (!upstreamKey) return null;
  if (!user && !pass) return null;

  const key = `${upstreamKey}::${user}::${pass}`;
  if (forwarders.has(key)) return forwarders.get(key);

  const upstream = parseUpstream(upstreamKey);
  const auth = basicAuth(user, pass);

  const srv = http.createServer((req, res) => {
    // Forward plain HTTP requests via upstream proxy.
    // Most traffic for Flow is HTTPS and will go through CONNECT; this is a best-effort fallback.
    try {
      const headers = { ...req.headers };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      headers['proxy-authorization'] = auth;
      headers['proxy-connection'] = 'keep-alive';

      const absoluteUrl = /^https?:\/\//i.test(String(req.url || ''))
        ? String(req.url)
        : `http://${String(req.headers.host || '')}${String(req.url || '/')}`;

      const upstreamReq = http.request(
        {
          host: upstream.host,
          port: upstream.port,
          method: req.method,
          path: absoluteUrl,
          headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers || {});
          upstreamRes.pipe(res);
        },
      );
      upstreamReq.on('error', () => {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('代理转发失败');
      });
      req.pipe(upstreamReq);
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('代理转发异常');
    }
  });

  srv.on('connect', (req, clientSocket, head) => {
    // HTTPS tunnel via upstream proxy with preemptive Proxy-Authorization.
    const target = String(req.url || '').trim();
    if (!target || !target.includes(':')) {
      try {
        clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch {}
      clientSocket.destroy();
      return;
    }

    const upstreamSocket = net.connect(upstream.port, upstream.host);
    upstreamSocket.setNoDelay(true);
    clientSocket.setNoDelay(true);

    let settled = false; // either failed (sent 502) or succeeded (sent 200)
    let connected = false; // after we wrote 200 to client
    const timeoutMs = 12_000;
    const handshakeTimer = setTimeout(() => fail('握手超时'), timeoutMs);
    upstreamSocket.setTimeout(timeoutMs);
    clientSocket.setTimeout(timeoutMs);

    function cleanupTimers() {
      try {
        clearTimeout(handshakeTimer);
      } catch {}
      try {
        upstreamSocket.setTimeout(0);
      } catch {}
      try {
        clientSocket.setTimeout(0);
      } catch {}
    }

    function fail(reason) {
      if (settled) return;
      settled = true;
      cleanupTimers();
      const reasonHeader = reason ? sanitizeHeaderValue(reason) : '';
      if (isDebug()) {
        try {
          console.warn(
            `[proxy-fwd] CONNECT 失败：${target}（上游 ${upstream.host}:${upstream.port}${
              reason ? `，原因：${reason}` : ''
            }）`,
          );
        } catch {}
      }
      try {
        const hdr = [
          'HTTP/1.1 502 Bad Gateway',
          reasonHeader ? `X-Proxy-Fwd-Reason: ${reasonHeader}` : null,
          '',
          '',
        ]
          .filter(Boolean)
          .join('\r\n');
        clientSocket.write(hdr);
      } catch {}
      try {
        clientSocket.destroy();
      } catch {}
      try {
        upstreamSocket.destroy();
      } catch {}
    }

    upstreamSocket.once('error', (e) => fail(e?.message || 'upstream error'));
    clientSocket.once('error', (e) => fail(e?.message || 'client error'));
    upstreamSocket.once('timeout', () => fail('upstream timeout'));
    clientSocket.once('timeout', () => fail('client timeout'));
    upstreamSocket.once('end', () => fail('upstream ended'));

    // Always close the other side when either side closes (both during handshake and after tunnel).
    clientSocket.once('close', () => {
      try {
        upstreamSocket.destroy();
      } catch {}
      if (!connected) fail('client closed');
    });
    upstreamSocket.once('close', () => {
      try {
        clientSocket.destroy();
      } catch {}
      if (!connected) fail('upstream closed');
    });

    upstreamSocket.once('connect', () => {
      const lines = [
        `CONNECT ${target} HTTP/1.1`,
        `Host: ${target}`,
        `Proxy-Authorization: ${auth}`,
        // Mimic curl-style headers; some vendor proxies behave better with these.
        'User-Agent: curl/8.7.1',
        'Accept: */*',
        'Proxy-Connection: Keep-Alive',
        '',
        '',
      ];
      upstreamSocket.write(lines.join('\r\n'));
    });

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;

      const header = buf.slice(0, idx + 4).toString('latin1');
      const first = header.split('\r\n', 1)[0] || '';
      const m = first.match(/HTTP\/\d\.\d\s+(\d+)/i);
      const code = m ? Number(m[1]) : 0;
      const rest = buf.slice(idx + 4);

      upstreamSocket.off('data', onData);
      cleanupTimers();

      if (code !== 200) {
        if (isDebug()) {
          try {
            console.warn(`[proxy-fwd] 上游响应：${sanitizeHeaderValue(first) || '—'}`);
          } catch {}
        }
        return fail(`upstream status ${code || 'unknown'} (${sanitizeHeaderValue(first) || '—'})`);
      }
      if (isDebug()) {
        try {
          console.log(`[proxy-fwd] CONNECT OK：${target}（上游 ${upstream.host}:${upstream.port}）`);
        } catch {}
      }

      try {
        clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if (rest.length) clientSocket.write(rest);
        if (head && head.length) upstreamSocket.write(head);
      } catch {
        return fail('write response failed');
      }

      settled = true;
      connected = true;
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    };

    upstreamSocket.on('data', onData);
  });

  const record = await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : null;
      if (!port) return reject(new Error('无法启动本地代理转发'));
      // Do not keep Node alive just because of this server.
      try {
        srv.unref();
      } catch {
        // ignore
      }
      resolve({ server: `http://127.0.0.1:${port}`, close: () => srv.close() });
    });
  });

  forwarders.set(key, record);
  return record;
}

module.exports = { getOrCreateForwarder };
