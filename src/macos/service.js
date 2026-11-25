import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  destroyInjectedWindows,
  detectMacAppPath,
  getMacAntigravityMainProcesses,
} from '../cdp/launcher.js';
import { isAntigravityUiTarget, listCdpTargets } from '../cdp/client.js';
import { formatUploadModeLabel, loadConfig } from '../cdp/uploader.js';

export const SERVICE_LABEL = 'com.antigravity.zh-lite';
export const LAUNCHER_APP_NAME = 'Antigravity 中文版.app';

export function getServicePaths() {
  const home = os.homedir();
  const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
  const logDir = path.join(home, 'Library', 'Logs', 'antigravity-zh-lite');
  const userAppsDir = path.join(home, 'Applications');
  return {
    launchAgentsDir,
    plistPath: path.join(launchAgentsDir, `${SERVICE_LABEL}.plist`),
    logDir,
    stdoutLog: path.join(logDir, 'daemon.log'),
    stderrLog: path.join(logDir, 'daemon.err.log'),
    userAppPath: path.join(userAppsDir, LAUNCHER_APP_NAME),
  };
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generateLaunchAgentPlist({ nodePath, binPath, rootDir, port, logDir }) {
  const nodeBinDir = path.dirname(nodePath);
  const envPath = [nodeBinDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter((v, i, arr) => v && arr.indexOf(v) === i)
    .join(':');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(binPath)}</string>
    <string>--daemon</string>
    <string>--port</string>
    <string>${escapeXml(String(port))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(rootDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(envPath)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, 'daemon.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, 'daemon.err.log'))}</string>
</dict>
</plist>
`;
}

/**
 * Create a lightweight native macOS .app launcher bundle that opens Antigravity
 * directly with --remote-debugging-port=<port> and reuses Antigravity's native icon.
 */
export function createMacLauncherApp({ appBundlePath, antigravityAppPath, port }) {
  const contentsDir = path.join(appBundlePath, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');

  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  // Try to reuse Antigravity's official .icns icon if accessible
  let iconFileName = '';
  try {
    const srcResources = path.join(antigravityAppPath, 'Contents', 'Resources');
    if (fs.existsSync(srcResources)) {
      const icns = fs.readdirSync(srcResources).find((f) => f.endsWith('.icns'));
      if (icns) {
        fs.copyFileSync(path.join(srcResources, icns), path.join(resourcesDir, icns));
        iconFileName = icns;
      }
    }
  } catch {
    // Fallback to default macOS app icon
  }

  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Antigravity 中文版</string>
  <key>CFBundleDisplayName</key>
  <string>Antigravity 中文版</string>
  <key>CFBundleIdentifier</key>
  <string>com.antigravity.zh-lite.launcher</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
${iconFileName ? `  <key>CFBundleIconFile</key>\n  <string>${escapeXml(iconFileName)}</string>\n` : ''}</dict>
</plist>
`;
  fs.writeFileSync(path.join(contentsDir, 'Info.plist'), infoPlist, 'utf8');

  const safeTarget = antigravityAppPath.replace(/"/g, '\\"');
  const script = `#!/bin/bash
PORT="${port}"
APP="${safeTarget}"

# If CDP is already open, simply activate Antigravity
if curl -sf "http://127.0.0.1:\${PORT}/json/version" >/dev/null 2>&1; then
  open -a "$APP"
  exit 0
fi

# If Antigravity main process is running without CDP, gracefully terminate by exact PID and relaunch
MAIN_PIDS=$(ps -axo pid=,args= | awk '/\/Contents\/MacOS\/Antigravity([[:space:]]|$)/ && !/--type=/ {print $1}')
if [ -n "$MAIN_PIDS" ]; then
  for p in $MAIN_PIDS; do
    kill -TERM "$p" >/dev/null 2>&1 || true
  done
  for _ in $(seq 1 24); do
    STILL=$(ps -axo pid=,args= | awk '/\/Contents\/MacOS\/Antigravity([[:space:]]|$)/ && !/--type=/ {print $1}')
    [ -z "$STILL" ] && break
    sleep 0.25
  done
fi

open -a "$APP" --args --remote-debugging-port="\${PORT}"
`;
  const execPath = path.join(macosDir, 'launcher');
  fs.writeFileSync(execPath, script, 'utf8');
  fs.chmodSync(execPath, 0o755);

  return appBundlePath;
}

function getUid() {
  return typeof process.getuid === 'function' ? process.getuid() : '';
}

function bootoutLaunchAgent(plistPath) {
  const uid = getUid();
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' });
  } catch {
    try {
      execFileSync('launchctl', ['unload', '-w', plistPath], { stdio: 'ignore' });
    } catch {
      // not currently loaded
    }
  }
}

function bootstrapLaunchAgent(plistPath) {
  const uid = getUid();
  try {
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'pipe' });
  } catch {
    execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'pipe' });
  }
}

export function installMacService({ rootDir, port, app }) {
  if (process.platform !== 'darwin') {
    throw new Error('install 命令当前仅支持 macOS LaunchAgent 常驻服务。');
  }

  const paths = getServicePaths();
  const nodePath = process.execPath;
  const binPath = path.join(rootDir, 'bin', 'ag-zh.js');
  const antigravityAppPath = detectMacAppPath(app);

  fs.mkdirSync(paths.launchAgentsDir, { recursive: true });
  fs.mkdirSync(paths.logDir, { recursive: true });

  // Ensure default config exists
  const configPath = path.join(rootDir, 'ag-zh.config.json');
  const examplePath = path.join(rootDir, 'ag-zh.config.example.json');
  if (!fs.existsSync(configPath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, configPath);
  }

  const plistContent = generateLaunchAgentPlist({
    nodePath,
    binPath,
    rootDir,
    port,
    logDir: paths.logDir,
  });
  fs.writeFileSync(paths.plistPath, plistContent, 'utf8');

  bootoutLaunchAgent(paths.plistPath);
  bootstrapLaunchAgent(paths.plistPath);

  // Create native .app launcher in ~/Applications and in project root for easy access
  createMacLauncherApp({
    appBundlePath: paths.userAppPath,
    antigravityAppPath,
    port,
  });

  const projectAppPath = path.join(rootDir, LAUNCHER_APP_NAME);
  createMacLauncherApp({
    appBundlePath: projectAppPath,
    antigravityAppPath,
    port,
  });

  return {
    plistPath: paths.plistPath,
    logPath: paths.stdoutLog,
    userAppPath: paths.userAppPath,
    projectAppPath,
    configPath,
  };
}

export async function uninstallMacService({ rootDir, port, purge = false }) {
  const paths = getServicePaths();
  // Stop LaunchAgent daemon FIRST so its poll loop cannot re-inject after destroyInjectedWindows()
  bootoutLaunchAgent(paths.plistPath);
  await new Promise((r) => setTimeout(r, 350));
  const restoredWindows = await destroyInjectedWindows(port);
  if (fs.existsSync(paths.plistPath)) {
    fs.rmSync(paths.plistPath, { force: true });
  }
  if (fs.existsSync(paths.userAppPath)) {
    fs.rmSync(paths.userAppPath, { recursive: true, force: true });
  }
  const projectAppPath = path.join(rootDir, LAUNCHER_APP_NAME);
  if (fs.existsSync(projectAppPath)) {
    fs.rmSync(projectAppPath, { recursive: true, force: true });
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
    removedPlist: paths.plistPath,
    removedUserApp: paths.userAppPath,
    removedProjectApp: projectAppPath,
    restoredWindows,
    purged,
  };
}

export async function getMacServiceStatus({ rootDir, port }) {
  const paths = getServicePaths();
  const config = loadConfig(rootDir);
  const installed = fs.existsSync(paths.plistPath);

  let serviceLoaded = false;
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
      serviceLoaded = out.includes(SERVICE_LABEL);
    } catch {
      serviceLoaded = false;
    }
  }

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
    plistPath: paths.plistPath,
    logPath: paths.stdoutLog,
    userAppExists: fs.existsSync(paths.userAppPath),
    userAppPath: paths.userAppPath,
    antigravityRunning: getMacAntigravityMainProcesses().length > 0,
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
