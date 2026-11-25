import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

let cachedSystemProxy = { value: null, checkedAt: 0 };
const PROXY_CACHE_TTL_MS = 30000;

export function parseMacScutilProxy(output) {
  if (!output) return null;
  const get = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm').exec(output);
    return m ? m[1].trim() : '';
  };
  if (get('HTTPSEnable') === '1' && get('HTTPSProxy') && get('HTTPSPort')) {
    return `http://${get('HTTPSProxy')}:${get('HTTPSPort')}`;
  }
  if (get('HTTPEnable') === '1' && get('HTTPProxy') && get('HTTPPort')) {
    return `http://${get('HTTPProxy')}:${get('HTTPPort')}`;
  }
  return null;
}

export function parseWinRegProxy(enableOut, serverOut) {
  if (!enableOut || !/0x1\b/i.test(enableOut)) return null;
  const m = /ProxyServer\s+REG_\w+\s+(.+)/i.exec(serverOut || '');
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return null;
  if (raw.includes('=')) {
    const httpsMatch = /https=([^;\s]+)/i.exec(raw);
    const httpMatch = /http=([^;\s]+)/i.exec(raw);
    const picked = (httpsMatch && httpsMatch[1]) || (httpMatch && httpMatch[1]);
    if (!picked) return null;
    return /^https?:\/\//i.test(picked) ? picked : `http://${picked}`;
  }
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
}

export function detectSystemProxy(explicitProxy = '') {
  if (explicitProxy === false || explicitProxy === 'none' || explicitProxy === 'direct') {
    return null;
  }
  if (explicitProxy && typeof explicitProxy === 'string' && explicitProxy.trim()) {
    return explicitProxy.trim();
  }
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  if (envProxy.trim()) return envProxy.trim();

  if (Date.now() - cachedSystemProxy.checkedAt < PROXY_CACHE_TTL_MS) {
    return cachedSystemProxy.value;
  }

  let detected = null;
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 });
      detected = parseMacScutilProxy(out);
    } else if (process.platform === 'win32') {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const enableOut = execFileSync('reg', ['query', key, '/v', 'ProxyEnable'], {
        encoding: 'utf8',
        timeout: 1500,
      });
      const serverOut = execFileSync('reg', ['query', key, '/v', 'ProxyServer'], {
        encoding: 'utf8',
        timeout: 1500,
      });
      detected = parseWinRegProxy(enableOut, serverOut);
    }
  } catch {
    detected = null;
  }

  cachedSystemProxy = { value: detected, checkedAt: Date.now() };
  return detected;
}

function wrapBufferedResponse(status, statusText, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusText || '',
    async json() {
      return JSON.parse(text);
    },
    async text() {
      return text;
    },
  };
}

/**
 * Zero-dependency HTTPS request via HTTP CONNECT proxy tunnel.
 * Ensures underlying connectReq, tunnel socket, and https request are all destroyed on timeout or error.
 */
export function requestViaHttpProxy(targetUrlStr, options = {}, proxyUrlStr, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrlStr);
    const proxy = new URL(proxyUrlStr);
    const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);

    let settled = false;
    let connectReq = null;
    let tunnelSocket = null;
    let httpsReq = null;

    const cleanupResources = () => {
      if (httpsReq) {
        try {
          if (httpsReq.socket && !httpsReq.socket.destroyed) httpsReq.socket.destroy();
          httpsReq.destroy();
        } catch {
          // ignore
        }
        httpsReq = null;
      }
      if (tunnelSocket) {
        try {
          tunnelSocket.destroy();
        } catch {
          // ignore
        }
        tunnelSocket = null;
      }
      if (connectReq) {
        try {
          connectReq.destroy();
        } catch {
          // ignore
        }
        connectReq = null;
      }
    };

    const done = (fn, val, destroySockets = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (destroySockets) cleanupResources();
      fn(val);
    };

    const timer = setTimeout(() => {
      done(reject, new Error(`Proxy request timeout (${timeoutMs}ms)`), true);
    }, timeoutMs);

    const proxyAuth =
      proxy.username || proxy.password
        ? 'Basic ' +
          Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
          ).toString('base64')
        : '';

    const connectHeaders = { Host: `${target.hostname}:${targetPort}` };
    if (proxyAuth) connectHeaders['Proxy-Authorization'] = proxyAuth;

    connectReq = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: connectHeaders,
    });

    connectReq.on('connect', (res, socket) => {
      tunnelSocket = socket;
      if (settled) {
        cleanupResources();
        return;
      }
      if (res.statusCode !== 200) {
        done(reject, new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`), true);
        return;
      }

      const headers = { ...(options.headers || {}) };
      const bodyStr = typeof options.body === 'string' ? options.body : '';
      if (bodyStr && !headers['Content-Length'] && !headers['content-length']) {
        headers['Content-Length'] = Buffer.byteLength(bodyStr, 'utf8');
      }

      httpsReq = https.request(
        {
          socket,
          servername: target.hostname,
          hostname: target.hostname,
          port: targetPort,
          path: target.pathname + target.search,
          method: options.method || 'GET',
          headers,
        },
        (httpRes) => {
          const chunks = [];
          httpRes.on('data', (chunk) => chunks.push(chunk));
          httpRes.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = httpRes.statusCode || 0;
            done(resolve, wrapBufferedResponse(status, httpRes.statusMessage, text), false);
          });
          httpRes.on('error', (err) => done(reject, err, true));
        }
      );

      httpsReq.on('error', (err) => done(reject, err, true));
      if (bodyStr) httpsReq.write(bodyStr);
      httpsReq.end();
    });

    connectReq.on('error', (err) => done(reject, err, true));
    connectReq.end();
  });
}

/**
 * Fetch wrapper that:
 * 1. Automatically honors explicit proxy, env proxy, or macOS/Windows system HTTP proxy.
 * 2. Covers BOTH response headers AND full response body read inside timeoutMs.
 */
export async function smartFetch(url, options = {}, { timeoutMs = 5000, proxy = '' } = {}) {
  const proxyUrl = detectSystemProxy(proxy);
  if (proxyUrl && url.startsWith('https://')) {
    return await requestViaHttpProxy(url, options, proxyUrl, timeoutMs);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    return wrapBufferedResponse(res.status, res.statusText, text);
  } finally {
    clearTimeout(timer);
  }
}
