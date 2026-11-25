/**
 * Zero-dependency Chrome DevTools Protocol (CDP) WebSocket client
 * using Node.js built-in WebSocket and fetch (>= Node 22).
 * Supports both JSON-RPC commands and real-time CDP event subscriptions
 * (such as Runtime.bindingCalled for CSP-safe page-to-daemon messaging).
 */

export async function listCdpTargets(port, host = '127.0.0.1') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`http://${host}:${port}/json/list`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Filter CDP targets so we ONLY inject into Antigravity UI pages/webviews,
 * never DevTools windows or external browsing tabs inside the built-in browser.
 */
export function isAntigravityUiTarget(target) {
  if (!target || !target.webSocketDebuggerUrl) return false;
  if (target.type !== 'page' && target.type !== 'webview') return false;

  const url = String(target.url || '');
  if (!url || url === 'about:blank') return false;
  if (url.startsWith('devtools://') || url.startsWith('chrome-extension://')) return false;

  if (
    url.startsWith('file://') ||
    url.startsWith('app://') ||
    url.startsWith('vscode-webview://') ||
    url.startsWith('http://localhost') ||
    url.startsWith('http://127.0.0.1') ||
    url.startsWith('https://localhost') ||
    url.startsWith('https://127.0.0.1')
  ) {
    return true;
  }

  return false;
}

export class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.closeHandlers = new Set();
    this.closed = false;
  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) {
      this.eventHandlers.set(method, new Set());
    }
    this.eventHandlers.get(method).add(handler);
    return () => this.eventHandlers.get(method)?.delete(handler);
  }

  onClose(handler) {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`CDP WebSocket connect timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });

      ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket error: ${err.message || 'connection failed'}`));
      });

      ws.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej, timer: t } = this.pending.get(msg.id);
          clearTimeout(t);
          this.pending.delete(msg.id);
          if (msg.error) {
            rej(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
          } else {
            res(msg.result);
          }
          return;
        }
        if (msg.method && this.eventHandlers.has(msg.method)) {
          for (const fn of this.eventHandlers.get(msg.method)) {
            try {
              fn(msg.params || {});
            } catch {
              // isolate listener errors
            }
          }
        }
      });

      ws.addEventListener('close', () => {
        this.closed = true;
        for (const { reject: rej, timer: t } of this.pending.values()) {
          clearTimeout(t);
          rej(new Error('CDP connection closed'));
        }
        this.pending.clear();
        for (const fn of this.closeHandlers) {
          try {
            fn();
          } catch {
            // ignore
          }
        }
      });
    });
  }

  isOpen() {
    return Boolean(this.ws && !this.closed && this.ws.readyState === WebSocket.OPEN);
  }

  send(method, params = {}, timeoutMs = 8000) {
    if (!this.isOpen()) {
      return Promise.reject(new Error('CDP client is not connected'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout on ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
  }
}
