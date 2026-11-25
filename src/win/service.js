import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  destroyInjectedWindows,
  detectWinAppPath,
  getAntigravityMainProcesses,
} from '../cdp/launcher.js';
import { isAntigravityUiTarget, listCdpTargets } from '../cdp/client.js';
import { formatUploadModeLabel, loadConfig } from '../cdp/uploader.js';

export const WIN_STARTUP_VBS = 'antigravity-zh-lite.vbs';
export const WIN_SHORTCUT_NAME = 'Antigravity 中文版.lnk';

export function getWinServicePaths() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const startupDir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const desktopDir = path.join(os.homedir(), 'Desktop');
  const logDir = path.join(localAppData, 'antigravity-zh-lite');

  return {
    startupDir,
    startupVbsPath: path.join(startupDir, WIN_STARTUP_VBS),
    desktopShortcutPath: path.join(desktopDir, WIN_SHORTCUT_NAME),
    logDir,
    logPath: path.join(logDir, 'daemon.log'),
  };
}

function escapeVbs(str) {
  return String(str).replace(/"/g, '""');
}

/**
 * Generate a Windows VBScript launcher that starts the Node daemon completely hidden (window style 0)
 * and redirects stdout/stderr to daemon.log so there is zero black CMD window on startup.
 */
export function generateWinDaemonVbs({ nodePath, binPath, port, logPath }) {
  const cmd = `cmd /c ""${nodePath}" "${binPath}" --daemon --port ${port} >> "${logPath}" 2>&1"`;
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${escapeVbs(cmd)}", 0, False`,
    '',
  ].join('\r\n');
}

function escapePsSingle(str) {
  return String(str).replace(/'/g, "''");
}

/**
 * Generate PowerShell command to create a native Windows .lnk shortcut pointing directly to
 * Antigravity.exe --remote-debugging-port=<port> with Antigravity's native icon.
 */
export function generateWinShortcutScript({ shortcutPath, targetExe, port }) {
  const safeShortcut = escapePsSingle(shortcutPath);
  const safeTarget = escapePsSingle(targetExe);
  const workDir = escapePsSingle(path.dirname(targetExe));
  return [
    '$ws = New-Object -ComObject WScript.Shell',
    `$sc = $ws.CreateShortcut('${safeShortcut}')`,
    `$sc.TargetPath = '${safeTarget}'`,
    `$sc.Arguments = '--remote-debugging-port=${Number(port)}'`,
    `$sc.WorkingDirectory = '${workDir}'`,
    `$sc.IconLocation = '${safeTarget},0'`,
    `$sc.Description = 'Antigravity 中文版 (已启用轻量化汉化调试端口)'`,
    '$sc.Save()',
  ].join('; ');
}

function stopExistingWinDaemon() {
  if (process.platform !== 'win32') return;
  try {
    const psCmd =
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*ag-zh.js*' -and $_.CommandLine -like '*--daemon*' } | " +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    execFileSync('powershell', ['-NoProfile', '-Command', psCmd], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    // ignore
  }
}

function isWinDaemonRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const psCmd =
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*ag-zh.js*' -and $_.CommandLine -like '*--daemon*' } | " +
      'Select-Object -ExpandProperty ProcessId';
    const out = execFileSync('powershell', ['-NoProfile', '-Command', psCmd], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    return Boolean(out);
  } catch {
    return false;
  }
}

export function installWinService({ rootDir, port, app }) {
  if (process.platform !== 'win32') {
    throw new Error('installWinService 仅在 Windows 系统上运行。');
  }

  const paths = getWinServicePaths();
  const nodePath = process.execPath;
  const binPath = path.join(rootDir, 'bin', 'ag-zh.js');
  const antigravityExe = detectWinAppPath(app);

  fs.mkdirSync(paths.startupDir, { recursive: true });
  fs.mkdirSync(paths.logDir, { recursive: true });

  const configPath = path.join(rootDir, 'ag-zh.config.json');
  const examplePath = path.join(rootDir, 'ag-zh.config.example.json');
  if (!fs.existsSync(configPath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, configPath);
  }

  stopExistingWinDaemon();

  const vbsContent = generateWinDaemonVbs({
    nodePath,
    binPath,
    port,
    logPath: paths.logPath,
  });
  fs.writeFileSync(paths.startupVbsPath, vbsContent, 'utf8');

  // Launch hidden daemon immediately via wscript.exe
  const child = spawn('wscript.exe', [paths.startupVbsPath], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.unref();

  let shortcutCreated = false;
  const projectShortcutPath = path.join(rootDir, WIN_SHORTCUT_NAME);
  if (antigravityExe && fs.existsSync(antigravityExe)) {
    try {
      const desktopPs = generateWinShortcutScript({
        shortcutPath: paths.desktopShortcutPath,
        targetExe: antigravityExe,
        port,
      });
      execFileSync('powershell', ['-NoProfile', '-Command', desktopPs], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const projectPs = generateWinShortcutScript({
        shortcutPath: projectShortcutPath,
        targetExe: antigravityExe,
        port,
      });
      execFileSync('powershell', ['-NoProfile', '-Command', projectPs], {
        stdio: 'ignore',
        windowsHide: true,
      });
      shortcutCreated = true;
    } catch {
      shortcutCreated = false;
    }
  }

  return {
    startupVbsPath: paths.startupVbsPath,
    logPath: paths.logPath,
    desktopShortcutPath: shortcutCreated ? paths.desktopShortcutPath : '',
    projectShortcutPath: shortcutCreated ? projectShortcutPath : '',
    configPath,
    antigravityExe,
  };
}

export async function uninstallWinService({ rootDir, port, purge = false }) {
  const paths = getWinServicePaths();
  // Stop background daemon FIRST so its poll loop cannot re-inject after destroyInjectedWindows()
  stopExistingWinDaemon();
  const restoredWindows = await destroyInjectedWindows(port);
  if (fs.existsSync(paths.startupVbsPath)) {
    fs.rmSync(paths.startupVbsPath, { force: true });
  }
  if (fs.existsSync(paths.desktopShortcutPath)) {
    fs.rmSync(paths.desktopShortcutPath, { force: true });
  }
  const projectShortcutPath = path.join(rootDir, WIN_SHORTCUT_NAME);
  if (fs.existsSync(projectShortcutPath)) {
    fs.rmSync(projectShortcutPath, { force: true });
  }

  const purged = [];
  if (purge) {
    const extras = [
      paths.logDir,
      path.join(rootDir, 'ag-zh.config.json'),
      path.join(rootDir, 'dicts', '_dynamic_cache.json'),
      path.join(rootDir, 'dicts', '_collected.json'),
    ];
    for (const target of extras) {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        purged.push(target);
      }
    }
  }

  return {
    removedStartup: paths.startupVbsPath,
    removedDesktopShortcut: paths.desktopShortcutPath,
    removedProjectShortcut: projectShortcutPath,
    restoredWindows,
    purged,
  };
}

export async function getWinServiceStatus({ rootDir, port }) {
  const paths = getWinServicePaths();
  const config = loadConfig(rootDir);
  const installed = fs.existsSync(paths.startupVbsPath);
  const serviceLoaded = isWinDaemonRunning();

  let cdpReachable = false;
  let uiTargets = [];
  try {
    const targets = await listCdpTargets(port);
    cdpReachable = true;
    uiTargets = targets.filter(isAntigravityUiTarget).map((t) => t.title || t.url);
  } catch {
    cdpReachable = false;
  }

  return {
    installed,
    serviceLoaded,
    serviceLabel: 'Windows 启动项 (Startup VBS)',
    logPath: paths.logPath,
    antigravityRunning: getAntigravityMainProcesses().length > 0,
    cdpPort: port,
    cdpReachable,
    uiTargets,
    autoFollow: config.autoFollow !== false,
    dynamicTranslate:
      config.dynamicTranslate?.enabled === false
        ? '关闭'
        : `开启 (${config.dynamicTranslate?.provider || 'google'})`,
    uploadMode: formatUploadModeLabel(config.upload),
  };
}
