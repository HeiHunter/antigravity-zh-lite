import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CdpClient,
  fetchCdpVersion,
  isAntigravityUiTarget,
  isAntigravityUrl,
  isChromiumCdpVersion,
  listCdpTargets,
} from './client.js';
import { DEFAULT_CDP_PORT, handleCollectedUpload, loadConfig } from './uploader.js';
import { createDynamicTranslator } from './translator.js';
import { buildAll } from '../../scripts/build.js';

const execFileAsync = promisify(execFile);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
const BRIDGE_BINDING_NAME = '__AG_ZH_BRIDGE__';
const UNINSTALLED_SESSION_KEY = '__ag_zh_uninstalled__';
const MAX_BRIDGE_PAYLOAD_BYTES = 256 * 1024;
const AUTO_FOLLOW_MAX_UPTIME_SEC = 15;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP_BYTES = 256 * 1024;
const MAC_MAIN_BIN_RE = /\/Contents\/MacOS\/Antigravity(?:\s|$)/;

/**
 * Validate whether an incoming CDP Runtime.bindingCalled event originates from
 * the top-level default execution context of a verified Antigravity UI page.
 */
export function isAllowedBridgeCall(session, params) {
  if (!session || !params) return false;
  if (params.name !== BRIDGE_BINDING_NAME || typeof params.payload !== 'string') return false;
  if (Buffer.byteLength(params.payload, 'utf8') > MAX_BRIDGE_PAYLOAD_BYTES) return false;
  if (
    session.mainContextId !== null &&
    typeof params.executionContextId === 'number' &&
    params.executionContextId !== session.mainContextId
  ) {
    return false;
  }
  return isAntigravityUrl(session.url, session.title);
}

/**
 * Update tracked session state on Page.frameNavigated (top-level frame only)
 * and return true only if the new URL is still a valid Antigravity UI page.
 */
export function applyMainFrameNavigation(session, params) {
  if (!session || !params?.frame || params.frame.parentId) return false;
  if (params.frame.id) session.mainFrameId = params.frame.id;
  if (params.frame.url) {
    session.url = String(params.frame.url);
    session.title = session.url;
  }
  return isAntigravityUrl(session.url, session.title);
}

/**
 * Refresh both the preload script (for future page reloads) and live dict on hot-reload.
 */
export async function refreshSessionOnHotReload(session, injectorSource, dictJson) {
  if (!session || !session.client || !session.client.isOpen()) return false;
  if (session.newDocScriptId) {
    await session.client
      .send('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: session.newDocScriptId,
      })
      .catch(() => {});
  }
  const nextReg = await session.client
    .send('Page.addScriptToEvaluateOnNewDocument', {
      source: injectorSource,
    })
    .catch(() => null);
  session.newDocScriptId = nextReg?.identifier || null;
  await evaluateOnClient(
    session.client,
    `window.__AG_ZH__ && window.__AG_ZH__.updateDict(${dictJson})`
  );
  return true;
}

/**
 * Target-PID auto-follow controller with:
 * - null vs [] distinction (process query failure never wipes ignoredPreExistingPids)
 * - uptime <= 15s filter for newly launched instances
 * - grace-period re-verification before quitting ONLY the matched candidate PID
 */
export function createAutoFollowController({
  getProcs,
  isCdpOpen,
  quitByPid,
  spawnApp,
  sleep = SLEEP,
  now = () => Date.now(),
  initialPids = [],
  maxUptimeSec = AUTO_FOLLOW_MAX_UPTIME_SEC,
  cooldownMs = 20000,
  graceMs = 1200,
  log = (msg) => console.log(msg),
  warn = (msg) => console.warn(msg),
}) {
  const ignoredPreExistingPids = new Set(initialPids);
  const handledAutoRelaunchPids = new Set();
  let lastAutoRelaunchAt = 0;
  let isAutoRelaunching = false;

  return {
    ignoredPreExistingPids,
    async check() {
      if (isAutoRelaunching) return false;
      if (now() - lastAutoRelaunchAt < cooldownMs) return false;

      const procs = await getProcs();
      if (procs === null) return false;

      const activePids = new Set(procs.map((p) => p.pid));
      for (const oldPid of [...ignoredPreExistingPids]) {
        if (!activePids.has(oldPid)) ignoredPreExistingPids.delete(oldPid);
      }

      const candidate = procs.find(
        (p) =>
          !ignoredPreExistingPids.has(p.pid) &&
          !handledAutoRelaunchPids.has(p.pid) &&
          !String(p.args || '').includes('--remote-debugging-port') &&
          (p.uptimeSec === null || p.uptimeSec <= maxUptimeSec)
      );
      if (!candidate) return procs.length > 0;

      handledAutoRelaunchPids.add(candidate.pid);
      isAutoRelaunching = true;
      lastAutoRelaunchAt = now();
      try {
        log(
          `[ag-zh] 检测到新启动的 Antigravity (PID ${candidate.pid}) 未开启调试端口，正在平滑重启接管...`
        );
        await sleep(graceMs);

        if (await isCdpOpen()) return true;

        const latestProcs = await getProcs();
        const stillCandidate =
          Array.isArray(latestProcs) &&
          latestProcs.find(
            (p) =>
              p.pid === candidate.pid &&
              !String(p.args || '').includes('--remote-debugging-port')
          );
        if (!stillCandidate) return true;

        const exited = await quitByPid(candidate.pid);
        if (exited) {
          spawnApp();
        }
        return true;
      } catch (err) {
        warn(`[ag-zh] 自动跟随接管失败: ${err.message}`);
        return true;
      } finally {
        isAutoRelaunching = false;
      }
    },
  };
}

/**
 * Parse POSIX ps etime ("MM:SS", "HH:MM:SS", or "D-HH:MM:SS") to integer seconds.
 */
export function parseMacEtimeToSeconds(etimeStr) {
  if (typeof etimeStr !== 'string') return null;
  const s = etimeStr.trim();
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s);
  if (!m) return null;
  const days = m[1] ? Number(m[1]) : 0;
  const hours = m[2] ? Number(m[2]) : 0;
  const mins = Number(m[3]);
  const secs = Number(m[4]);
  return days * 86400 + hours * 3600 + mins * 60 + secs;
}

export function truncateLogIfOversized(logPath) {
  try {
    if (!logPath || !fs.existsSync(logPath)) return false;
    const stat = fs.statSync(logPath);
    if (stat.size <= LOG_MAX_BYTES) return false;
    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(LOG_KEEP_BYTES);
      fs.readSync(fd, buf, 0, LOG_KEEP_BYTES, stat.size - LOG_KEEP_BYTES);
      fs.writeFileSync(logPath, buf);
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function detectMacAppPath(customApp) {
  if (customApp) return customApp;
  const candidates = [
    '/Applications/Antigravity.app',
    path.join(os.homedir(), 'Applications', 'Antigravity.app'),
    '/Applications/Antigravity 2.app',
    path.join(os.homedir(), 'Applications', 'Antigravity 2.app'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'Antigravity';
}

export function detectWinAppPath(customApp) {
  if (customApp) return customApp;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
    path.join(localAppData, 'Antigravity', 'Antigravity.exe'),
    path.join(programFiles, 'Antigravity', 'Antigravity.exe'),
    path.join(programFilesX86, 'Antigravity', 'Antigravity.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function parseMacPsOutput(out) {
  const results = [];
  for (const rawLine of String(out || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(\S+)\s+([\s\S]+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const uptimeSec = parseMacEtimeToSeconds(m[2]);
    const args = m[3];
    if (!MAC_MAIN_BIN_RE.test(args)) continue;
    if (args.includes('--type=')) continue;
    results.push({ pid, uptimeSec, args });
  }
  return results;
}

function parseWinCimOutput(out) {
  const trimmed = String(out || '').trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const results = [];
  const now = Date.now();
  for (const item of list) {
    if (!item || !item.ProcessId) continue;
    const args = String(item.CommandLine || '');
    if (args.includes('--type=')) continue;
    let uptimeSec = null;
    if (typeof item.CreationDate === 'string') {
      const msMatch = /\/Date\((\d+)\)\//.exec(item.CreationDate);
      const ts = msMatch ? Number(msMatch[1]) : Date.parse(item.CreationDate);
      if (Number.isFinite(ts)) {
        uptimeSec = Math.max(0, Math.floor((now - ts) / 1000));
      }
    }
    results.push({ pid: Number(item.ProcessId), uptimeSec, args });
  }
  return results;
}

export function getMacAntigravityMainProcesses() {
  if (process.platform !== 'darwin') return [];
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,etime=,args='], { encoding: 'utf8' });
    return parseMacPsOutput(out);
  } catch {
    return [];
  }
}

export function getWinAntigravityMainProcesses() {
  if (process.platform !== 'win32') return [];
  try {
    const quick = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (!/Antigravity\.exe/i.test(quick)) return [];
    const psCmd =
      "Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" | " +
      'Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress';
    const out = execFileSync('powershell', ['-NoProfile', '-Command', psCmd], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return parseWinCimOutput(out);
  } catch {
    return [];
  }
}

export function getAntigravityMainProcesses() {
  if (process.platform === 'darwin') return getMacAntigravityMainProcesses();
  if (process.platform === 'win32') return getWinAntigravityMainProcesses();
  return [];
}

/**
 * Async process discovery that returns `null` on query error (distinct from `[]` when no process is running)
 * so transient failures never wipe ignoredPreExistingPids.
 * On Windows, checks lightweight `tasklist` first so idle polling avoids spawning PowerShell.
 */
export async function getAntigravityMainProcessesAsync() {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,etime=,args='], {
        encoding: 'utf8',
        timeout: 3000,
      });
      return parseMacPsOutput(stdout);
    }
    if (process.platform === 'win32') {
      const { stdout: quick } = await execFileAsync(
        'tasklist',
        ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'],
        { encoding: 'utf8', timeout: 3000, windowsHide: true }
      );
      if (!/Antigravity\.exe/i.test(quick)) {
        return [];
      }
      const psCmd =
        "Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" | " +
        'Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress';
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', psCmd], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      return parseWinCimOutput(stdout);
    }
    return [];
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gracefully terminate ONE specific Antigravity PID (never blanket-kills other instances).
 */
async function quitProcessByPid(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(pid)], {
        timeout: 3000,
        windowsHide: true,
      }).catch(() => {});
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // process may already have exited
  }

  for (let i = 0; i < 24; i++) {
    if (!isPidAlive(pid)) return true;
    await SLEEP(250);
  }
  return !isPidAlive(pid);
}

async function quitAllRunningInteractive() {
  const procs = (await getAntigravityMainProcessesAsync()) || [];
  for (const p of procs) {
    await quitProcessByPid(p.pid);
  }
  const remain = (await getAntigravityMainProcessesAsync()) || [];
  return remain.length === 0;
}

function spawnAppWithDebugPort(customApp, port) {
  if (process.platform === 'win32') {
    const exePath = detectWinAppPath(customApp);
    if (!exePath) {
      throw new Error(
        '未自动找到 Antigravity.exe。请通过 --app "C:\\path\\to\\Antigravity.exe" 或在 ag-zh.config.json 中配置 app 路径。'
      );
    }
    const child = spawn(exePath, [`--remote-debugging-port=${port}`], {
      stdio: 'ignore',
      detached: true,
      windowsHide: false,
    });
    child.unref();
    return exePath;
  }

  const targetApp = detectMacAppPath(customApp);
  const child = spawn('open', ['-a', targetApp, '--args', `--remote-debugging-port=${port}`], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  return targetApp;
}

export async function ensureCdpReady({ port, app, restart = false, attachOnly = false }) {
  try {
    const ver = await fetchCdpVersion(port);
    if (isChromiumCdpVersion(ver)) {
      await listCdpTargets(port);
      return { launched: false };
    }
  } catch {
    // Port not open yet
  }

  if (attachOnly) {
    const hint =
      process.platform === 'win32'
        ? `  "Antigravity.exe" --remote-debugging-port=${port}`
        : `  open -a Antigravity --args --remote-debugging-port=${port}`;
    throw new Error(`未检测到调试端口 ${port}。请先使用调试参数启动 Antigravity：\n${hint}`);
  }

  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error(
      `自动拉起目前支持 macOS 与 Windows。Linux 请手动以 --remote-debugging-port=${port} 启动 Antigravity 后使用 --attach-only 挂载。`
    );
  }

  const running = ((await getAntigravityMainProcessesAsync()) || []).length > 0;
  if (running) {
    if (!restart) {
      throw new Error(
        `检测到 Antigravity 已在运行，但未开启调试端口 ${port}。\n` +
          `请选择以下任一方式：\n` +
          `  1. 先完全退出 Antigravity，再重新运行本工具；\n` +
          `  2. 直接运行：node bin/ag-zh.js --restart（将自动优雅退出并重启）。`
      );
    }
    console.log('[ag-zh] 正在优雅关闭现有 Antigravity 实例...');
    const exited = await quitAllRunningInteractive();
    if (!exited) {
      throw new Error('等待 Antigravity 退出超时，请手动完全退出后重试。');
    }
  }

  const launchedTarget = spawnAppWithDebugPort(app, port);
  console.log(`[ag-zh] 正在以调试端口 ${port} 启动 ${launchedTarget} ...`);

  for (let i = 0; i < 60; i++) {
    await SLEEP(250);
    try {
      const targets = await listCdpTargets(port);
      if (targets.some(isAntigravityUiTarget)) {
        return { launched: true };
      }
    } catch {
      // keep polling
    }
  }

  throw new Error(
    `等待 Antigravity CDP 端口 ${port} 就绪超时（15s）。请确认客户端已成功打开且未被禁止远程调试端口。`
  );
}

async function evaluateOnClient(client, expression) {
  const res = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return res?.result?.value;
}

async function evaluateInTargetOnce(target, expression) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.connect();
    return await evaluateOnClient(client, expression);
  } finally {
    client.close();
  }
}

/**
 * Best-effort teardown of injected UI & observer in currently open Antigravity windows (used on uninstall).
 * Sets a per-tab sessionStorage sentinel so even if a pre-registered preload script lingers until restart,
 * refreshing the window will NOT re-localize it.
 */
export async function destroyInjectedWindows(port = DEFAULT_CDP_PORT) {
  let destroyed = 0;
  try {
    const ver = await fetchCdpVersion(port);
    if (!isChromiumCdpVersion(ver)) return 0;
    const targets = (await listCdpTargets(port)).filter(isAntigravityUiTarget);
    const expr =
      `(function(){try{if(typeof sessionStorage!=="undefined"){sessionStorage.setItem(${JSON.stringify(UNINSTALLED_SESSION_KEY)},"1");}}catch(e){}` +
      `if(window.__AG_ZH__&&typeof window.__AG_ZH__.destroy==="function"){window.__AG_ZH__.destroy();delete window.__AG_ZH__;return true;}return false;})()`;
    for (const target of targets) {
      try {
        await evaluateInTargetOnce(target, expr);
        destroyed++;
      } catch {
        // ignore unreachable target
      }
    }
  } catch {
    // CDP not running
  }
  return destroyed;
}

export async function runLauncher(options) {
  const { rootDir } = options;
  const config = loadConfig(rootDir);
  const port = options.port || config.port || DEFAULT_CDP_PORT;
  const app = options.app || config.app || '';
  const restart = Boolean(options.restart);
  const attachOnly = Boolean(options.attachOnly);
  const once = Boolean(options.once);
  const daemon = Boolean(options.daemon);
  const watch = options.watch !== undefined ? options.watch : config.watchDicts !== false;
  const autoFollow =
    options.autoFollow !== undefined ? options.autoFollow : config.autoFollow !== false;

  if (daemon) {
    const defaultLogPath =
      process.platform === 'win32'
        ? path.join(
            process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
            'antigravity-zh-lite',
            'daemon.log'
          )
        : path.join(os.homedir(), 'Library', 'Logs', 'antigravity-zh-lite', 'daemon.log');
    truncateLogIfOversized(defaultLogPath);
  }

  const built = buildAll();
  let injectorSource = fs.readFileSync(built.injectorPath, 'utf8');
  const dynamicTranslator = createDynamicTranslator({ rootDir, config });
  console.log(
    `[ag-zh] 引擎构建完成 (${built.sizeKB} KB | ${built.stats.exactCount} 精确词条, ${built.stats.patternCount} 动态模板, ${dynamicTranslator.getCacheSize()} 动态缓存)`
  );

  if (!daemon) {
    await ensureCdpReady({ port, app, restart, attachOnly });
  } else {
    console.log(
      `[ag-zh] 常驻守护模式已启动（端口 ${port}，平台 ${process.platform}，自动跟随接管: ${autoFollow ? '开启' : '关闭'}）`
    );
  }

  /** @type {Map<string, { client: CdpClient, title: string, url: string, reinjecting: boolean, mainFrameId: string|null, mainContextId: number|null, newDocScriptId: string|null }>} */
  const sessions = new Map();
  const connecting = new Set();

  // Record pre-existing Antigravity PIDs at daemon start so we never kill an active session on service boot
  const initialProcs = (await getAntigravityMainProcessesAsync()) || [];
  const autoFollowController = createAutoFollowController({
    getProcs: getAntigravityMainProcessesAsync,
    isCdpOpen: async () => {
      try {
        await fetchCdpVersion(port);
        return true;
      } catch {
        return false;
      }
    },
    quitByPid: quitProcessByPid,
    spawnApp: () => spawnAppWithDebugPort(app, port),
    initialPids: initialProcs.map((p) => p.pid),
  });

  async function injectNow(client, label = '') {
    if (!client.isOpen()) return false;
    await client.send('Runtime.addBinding', { name: BRIDGE_BINDING_NAME }).catch(() => {});
    // Clear any prior post-uninstall sentinel when actively re-injecting from a running daemon
    await evaluateOnClient(
      client,
      `try{if(typeof sessionStorage!=="undefined"){sessionStorage.removeItem(${JSON.stringify(UNINSTALLED_SESSION_KEY)});}}catch(e){}`
    ).catch(() => {});
    const res = await client.send('Runtime.evaluate', {
      expression: injectorSource,
      awaitPromise: false,
      returnByValue: false,
    });
    if (res && res.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        'unknown runtime error';
      console.warn(`[ag-zh] 注入脚本异常 (${label}): ${desc}`);
      return false;
    }
    return true;
  }

  async function ensureInjectedOnSession(session) {
    if (!session || session.reinjecting || !session.client.isOpen()) return;
    if (!isAntigravityUrl(session.url, session.title)) return;
    session.reinjecting = true;
    try {
      const alive = await evaluateOnClient(
        session.client,
        `Boolean(window.__AG_ZH__ && typeof window.__AG_ZH_BRIDGE__ === "function" && (!document.body || document.getElementById("ag-zh-host")))`
      );
      if (!alive) {
        const ok = await injectNow(session.client, session.title);
        if (ok) {
          console.log(`[ag-zh] 检测到页面跳转/重载，已自动补注汉化引擎 -> ${session.title}`);
        }
      }
    } catch {
      // ignore transient navigation race
    } finally {
      session.reinjecting = false;
    }
  }

  async function attachPersistentTarget(target) {
    if (sessions.has(target.id) || connecting.has(target.id)) return;
    connecting.add(target.id);
    const client = new CdpClient(target.webSocketDebuggerUrl);
    const label = target.title || target.url;
    try {
      await client.connect();
      await client.send('Page.enable').catch(() => {});
      await client.send('Runtime.enable').catch(() => {});
      await client.send('Runtime.addBinding', { name: BRIDGE_BINDING_NAME }).catch(() => {});

      let mainFrameId = null;
      try {
        const tree = await client.send('Page.getFrameTree');
        mainFrameId = tree?.frameTree?.frame?.id || null;
      } catch {
        mainFrameId = null;
      }

      const session = {
        client,
        title: label,
        url: String(target.url || ''),
        reinjecting: false,
        mainFrameId,
        mainContextId: null,
        newDocScriptId: null,
      };

      client.on('Runtime.executionContextCreated', (params) => {
        const ctx = params?.context;
        if (!ctx || !ctx.auxData?.isDefault) return;
        if (!session.mainFrameId || ctx.auxData.frameId === session.mainFrameId) {
          session.mainContextId = ctx.id;
        }
      });

      client.on('Runtime.executionContextsCleared', () => {
        session.mainContextId = null;
      });

      client.on('Runtime.bindingCalled', async (params) => {
        if (!isAllowedBridgeCall(session, params)) return;

        let msg;
        try {
          msg = JSON.parse(params.payload);
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'translate_dynamic' && Array.isArray(msg.texts)) {
          try {
            const latestConfig = loadConfig(rootDir);
            const result = await dynamicTranslator.translateTexts(msg.texts, latestConfig);
            if (Object.keys(result.translations).length > 0 && client.isOpen()) {
              await evaluateOnClient(
                client,
                `window.__AG_ZH__ && window.__AG_ZH__.__onDynamicTranslations(${JSON.stringify(result.translations)})`
              ).catch(() => {});
              if (result.fetched > 0) {
                console.log(
                  `[ag-zh] 动态翻译弹窗文案：新译 ${result.fetched} 条（缓存命中 ${result.fromCache} 条，总缓存 ${dynamicTranslator.getCacheSize()} 条）`
                );
              }
            }
          } catch (err) {
            console.warn(`[ag-zh] 动态翻译失败: ${err.message}`);
          }
        } else if (msg.type === 'upload_collected') {
          try {
            const latestConfig = loadConfig(rootDir);
            const res = await handleCollectedUpload({
              rootDir,
              payload: msg.payload,
              meta: msg.meta,
              config: latestConfig,
            });
            console.log(
              `[ag-zh] 自动接收采集词条：新增 ${res.incomingCount} 条（累计 ${res.totalCount} 条 -> dicts/_collected.json，远端状态: ${res.remoteStatus}）`
            );
            if (client.isOpen()) {
              await evaluateOnClient(
                client,
                `window.__AG_ZH__ && window.__AG_ZH__.__onUploadResult(${JSON.stringify(res)})`
              ).catch(() => {});
            }
          } catch (err) {
            console.error(`[ag-zh] 处理采集上传失败: ${err.message}`);
            if (client.isOpen()) {
              await evaluateOnClient(
                client,
                `window.__AG_ZH__ && window.__AG_ZH__.__onUploadResult(${JSON.stringify({
                  ok: false,
                  error: err.message,
                })})`
              ).catch(() => {});
            }
          }
        }
      });

      const scheduleEnsure = () => {
        setTimeout(() => {
          ensureInjectedOnSession(session);
        }, 250);
      };
      client.on('Page.loadEventFired', scheduleEnsure);
      client.on('Page.domContentEventFired', scheduleEnsure);
      client.on('Page.frameNavigated', (params) => {
        if (applyMainFrameNavigation(session, params)) {
          scheduleEnsure();
        }
      });

      client.onClose(() => {
        sessions.delete(target.id);
      });

      const addRes = await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: injectorSource,
      });
      session.newDocScriptId = addRes?.identifier || null;
      await injectNow(client, label);

      if (once) {
        client.close();
      } else {
        sessions.set(target.id, session);
      }
      console.log(`[ag-zh] 已挂载汉化引擎 -> ${label}`);
    } catch (err) {
      client.close();
      console.warn(`[ag-zh] 挂载目标失败 (${target.id}): ${err.message}`);
    } finally {
      connecting.delete(target.id);
    }
  }

  async function maybeAutoFollowNewApp() {
    if (!daemon || !autoFollow || (process.platform !== 'darwin' && process.platform !== 'win32')) {
      return false;
    }
    return await autoFollowController.check();
  }

  async function scanAndInject() {
    let targets;
    try {
      const ver = await fetchCdpVersion(port);
      if (!isChromiumCdpVersion(ver)) {
        return { cdpActive: false, appSeen: false };
      }
      targets = await listCdpTargets(port);
    } catch {
      for (const [id, session] of sessions.entries()) {
        session.client.close();
        sessions.delete(id);
      }
      const appSeen = await maybeAutoFollowNewApp();
      return { cdpActive: false, appSeen };
    }

    const uiTargets = targets.filter(isAntigravityUiTarget);
    const aliveIds = new Set(uiTargets.map((t) => t.id));
    for (const [id, session] of sessions.entries()) {
      if (!aliveIds.has(id) || !session.client.isOpen()) {
        session.client.close();
        sessions.delete(id);
      }
    }

    for (const target of uiTargets) {
      const existing = sessions.get(target.id);
      if (!existing) {
        await attachPersistentTarget(target);
      } else {
        if (target.title) existing.title = target.title;
        if (target.url) existing.url = String(target.url);
        await ensureInjectedOnSession(existing);
      }
    }
    return { cdpActive: true, appSeen: true };
  }

  await scanAndInject();

  if (once) {
    console.log('[ag-zh] 单次注入完成（--once 模式退出）。');
    return;
  }

  if (!daemon) {
    console.log(
      `[ag-zh] 守护运行中（端口 ${port}）| 右下角按钮可切换中英/一键采集自动上传 · Ctrl+C 退出守护`
    );
  }

  let watcher = null;
  if (watch) {
    const dictsDir = path.join(rootDir, 'dicts');
    let debounceTimer = null;
    watcher = fs.watch(dictsDir, (_event, filename) => {
      if (!filename || !filename.endsWith('.json') || filename.startsWith('_')) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        try {
          const next = buildAll();
          injectorSource = fs.readFileSync(next.injectorPath, 'utf8');
          const dictJson = fs.readFileSync(next.dictPath, 'utf8');
          let updated = 0;
          for (const session of sessions.values()) {
            const ok = await refreshSessionOnHotReload(session, injectorSource, dictJson);
            if (ok) updated++;
          }
          console.log(
            `[ag-zh] 检测到词库变更 (${filename})，已热更新 ${updated} 个窗口 (${next.stats.exactCount} 词条)`
          );
        } catch (err) {
          console.error(`[ag-zh] 词库热更新失败: ${err.message}`);
        }
      }, 250);
    });
  }

  // Serialized setTimeout poll loop (guarantees zero overlapping scans) with gentle idle backoff
  let stopped = false;
  let pollTimer = null;
  const scheduleNextPoll = (delayMs) => {
    if (stopped) return;
    pollTimer = setTimeout(async () => {
      let nextDelay = 2000;
      try {
        const res = await scanAndInject();
        nextDelay = res.cdpActive || res.appSeen ? 2000 : 4000;
      } catch {
        nextDelay = 4000;
      }
      scheduleNextPoll(nextDelay);
    }, delayMs);
  };
  scheduleNextPoll(2000);

  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (watcher) watcher.close();

    // Best-effort revoke registered preload scripts so reloading open tabs won't re-inject after daemon exits
    const forceExitTimer = setTimeout(() => process.exit(0), 1200);
    try {
      await Promise.all(
        [...sessions.values()].map(async (session) => {
          if (session.client.isOpen() && session.newDocScriptId) {
            await session.client
              .send(
                'Page.removeScriptToEvaluateOnNewDocument',
                { identifier: session.newDocScriptId },
                800
              )
              .catch(() => {});
            session.newDocScriptId = null;
          }
          session.client.close();
        })
      );
    } finally {
      clearTimeout(forceExitTimer);
      sessions.clear();
      console.log('\n[ag-zh] 已退出守护进程（已撤销预注入脚本）。');
      process.exit(0);
    }
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

export async function dumpCollectedFromCdp({ port = DEFAULT_CDP_PORT, outputPath }) {
  const targets = (await listCdpTargets(port)).filter(isAntigravityUiTarget);
  if (targets.length === 0) {
    throw new Error(`端口 ${port} 上未找到 Antigravity 页面目标。`);
  }

  const merged = {};
  for (const target of targets) {
    const data = await evaluateInTargetOnce(
      target,
      'window.__AG_ZH__ ? window.__AG_ZH__.exportCollected() : null'
    );
    if (data && data.exact) {
      Object.assign(merged, data.exact);
    }
  }

  const count = Object.keys(merged).length;
  fs.writeFileSync(outputPath, JSON.stringify({ exact: merged }, null, 2) + '\n', 'utf8');
  return { count, outputPath };
}

export async function toggleCollectorInCdp({ port = DEFAULT_CDP_PORT, enabled = true }) {
  const targets = (await listCdpTargets(port)).filter(isAntigravityUiTarget);
  for (const target of targets) {
    await evaluateInTargetOnce(
      target,
      `window.__AG_ZH__ && window.__AG_ZH__.setCollector(${Boolean(enabled)})`
    );
  }
  return targets.length;
}
