#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Friendly Node.js >= 22 version guard before importing WebSocket-dependent modules
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
  console.error(
    `\n[ag-zh] 需要 Node.js >= 22.0.0（当前版本为 v${process.versions.node}）。\n` +
      '本插件基于 Node 原生 WebSocket 实现零第三方依赖运行，请先升级 Node.js：\n' +
      '  • 官网下载：https://nodejs.org/\n' +
      '  • macOS Homebrew：brew install node\n' +
      '  • Windows winget：winget install OpenJS.NodeJS.LTS\n'
  );
  process.exit(1);
}

import {
  dumpCollectedFromCdp,
  runLauncher,
  toggleCollectorInCdp,
} from '../src/cdp/launcher.js';
import { DEFAULT_CDP_PORT, loadConfig } from '../src/cdp/uploader.js';
import {
  getMacServiceStatus,
  installMacService,
  uninstallMacService,
} from '../src/macos/service.js';
import {
  getWinServiceStatus,
  installWinService,
  uninstallWinService,
} from '../src/win/service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function printHelp() {
  console.log(`
antigravity-zh-lite — Antigravity 2.0 轻量化运行时汉化插件 (macOS / Windows)

用法:
  node bin/ag-zh.js [子命令] [选项]

子命令（开机常驻推荐，支持 macOS 与 Windows）:
  install           一键安装开机常驻守护并生成「Antigravity 中文版」快捷启动器
  uninstall         卸载常驻守护与快捷启动器并恢复已开窗口（加 --purge 一并清理配置/缓存/日志）
  status            查看常驻服务、Antigravity 调试端口、动态翻译与上传配置状态

运行选项:
  --daemon          后台静默常驻模式（跟随 Antigravity 自动打开并自动汉化）
  --port <端口>     指定 CDP 调试端口（默认: 19229，也可在 ag-zh.config.json 配置）
  --app <路径/名称> 指定 Antigravity 安装路径（macOS .app / Windows .exe）
  --restart         若 Antigravity 已在运行且无调试端口，自动优雅退出并重启
  --attach-only     仅挂载到已开启调试端口的客户端，不尝试拉起应用
  --no-auto-follow  禁用「检测到新打开官方 Antigravity 时自动平滑接管」
  --purge           配合 uninstall 使用，一并删除本地配置、翻译缓存、采集记录与日志
  --once            仅注入一次后退出（默认保持轻量守护，自动挂载新窗口与热更新词库）
  --no-watch        禁用 dicts/*.json 文件变动热更新
  --collect         开启已挂载窗口的「未翻译词条采集模式」
  --dump            手动导出当前采集到的未翻译词条到 dicts/_collected.json
  -h, --help        显示帮助信息

界面操作（右下角胶囊）:
  左键 [中/EN]      实时无损切换中文 / 英文（快捷键 Option/Alt + Shift + L）
  左键 [采集]       开始采集未译词条 → 点击 [结束 (N)] 自动保存并上传（Option/Alt + Shift + C）
  Option/Alt+Shift+H 隐藏 / 显示右下角悬浮胶囊
`);
}

function parseArgs(argv) {
  let command = 'run';
  const rest = [];
  if (argv[0] && ['install', 'uninstall', 'status'].includes(argv[0])) {
    command = argv[0];
    rest.push(...argv.slice(1));
  } else {
    rest.push(...argv);
  }

  const config = loadConfig(ROOT);
  const opts = {
    command,
    port: config.port || DEFAULT_CDP_PORT,
    app: config.app || '',
    restart: false,
    attachOnly: false,
    once: false,
    daemon: false,
    watch: config.watchDicts !== false,
    autoFollow: config.autoFollow !== false,
    purge: false,
    collect: false,
    dump: false,
    help: false,
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--restart') opts.restart = true;
    else if (arg === '--attach-only') opts.attachOnly = true;
    else if (arg === '--once') opts.once = true;
    else if (arg === '--daemon') opts.daemon = true;
    else if (arg === '--no-watch') opts.watch = false;
    else if (arg === '--watch') opts.watch = true;
    else if (arg === '--no-auto-follow') opts.autoFollow = false;
    else if (arg === '--purge') opts.purge = true;
    else if (arg === '--collect') opts.collect = true;
    else if (arg === '--dump') opts.dump = true;
    else if (arg === '--port' && rest[i + 1]) {
      opts.port = Number(rest[++i]);
    } else if (arg === '--app' && rest[i + 1]) {
      opts.app = rest[++i];
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  if (opts.command === 'install') {
    if (process.platform === 'darwin') {
      const res = installMacService({ rootDir: ROOT, port: opts.port, app: opts.app });
      console.log('\n✅ Antigravity 汉化常驻服务已安装并启动（macOS）！');
      console.log(`  • 常驻服务配置 : ${res.plistPath}`);
      console.log(`  • 后台日志文件 : ${res.logPath}`);
      console.log(`  • 快捷启动器   : ${res.userAppPath}`);
      console.log(`  • 项目内启动器 : ${res.projectAppPath}`);
      console.log(`  • 配置文件     : ${res.configPath}`);
      console.log('\n使用提示：');
      console.log('  1. 下次直接打开 Antigravity（或把「Antigravity 中文版.app」拖到 Dock），会自动汉化并常驻；');
      console.log('  2. 运行 node bin/ag-zh.js status 可随时查看运行状态；');
      console.log('  3. 动态长句翻译默认开启（发送至 Google 翻译前会对路径/URL/命令占位符脱敏并本地缓存）；如需纯离线静态汉化，请在 ag-zh.config.json 将 dynamicTranslate.enabled 设为 false。\n');
      return;
    }
    if (process.platform === 'win32') {
      const res = installWinService({ rootDir: ROOT, port: opts.port, app: opts.app });
      console.log('\n✅ Antigravity 汉化常驻服务已安装并启动（Windows 无黑框模式）！');
      console.log(`  • 开机自启脚本 : ${res.startupVbsPath}`);
      console.log(`  • 后台日志文件 : ${res.logPath}`);
      if (res.desktopShortcutPath) {
        console.log(`  • 桌面快捷方式 : ${res.desktopShortcutPath}`);
        console.log(`  • 项目快捷方式 : ${res.projectShortcutPath}`);
      } else {
        console.log('  • 提示：未自动探测到 Antigravity.exe，可在 ag-zh.config.json 中填写 app 路径后重跑 install。');
      }
      console.log(`  • 配置文件     : ${res.configPath}`);
      console.log('\n使用提示：');
      console.log('  1. 下次直接打开 Antigravity（或双击桌面「Antigravity 中文版」图标），会自动汉化并常驻；');
      console.log('  2. 运行 node bin/ag-zh.js status 可随时查看运行状态；');
      console.log('  3. 动态长句翻译默认开启（发送至 Google 翻译前会对路径/URL/命令占位符脱敏并本地缓存）；如需纯离线静态汉化，请在 ag-zh.config.json 将 dynamicTranslate.enabled 设为 false。\n');
      return;
    }
    throw new Error('install 常驻服务当前支持 macOS 与 Windows，Linux 请使用 --daemon 配合 systemd 运行。');
  }

  if (opts.command === 'uninstall') {
    if (process.platform === 'darwin') {
      const res = await uninstallMacService({ rootDir: ROOT, port: opts.port, purge: opts.purge });
      console.log('\n✅ 已卸载 Antigravity 汉化常驻服务（macOS）：');
      console.log(`  • 已移除服务 : ${res.removedPlist}`);
      console.log(`  • 已移除应用 : ${res.removedUserApp}`);
      if (res.restoredWindows > 0) {
        console.log(`  • 已恢复窗口 : ${res.restoredWindows} 个已打开窗口已即时切回英文`);
      }
      if (res.purged.length > 0) {
        console.log(`  • 已额外清理 : ${res.purged.join(', ')}`);
      } else {
        console.log('  • 提示：已保留本地配置、翻译缓存与日志（如需一并清理，请运行 uninstall --purge）；重启 Antigravity 后调试端口将关闭。');
      }
      console.log('');
      return;
    }
    if (process.platform === 'win32') {
      const res = await uninstallWinService({ rootDir: ROOT, port: opts.port, purge: opts.purge });
      console.log('\n✅ 已卸载 Antigravity 汉化常驻服务（Windows）：');
      console.log(`  • 已移除启动项 : ${res.removedStartup}`);
      console.log(`  • 已移除快捷方式: ${res.removedDesktopShortcut}`);
      if (res.restoredWindows > 0) {
        console.log(`  • 已恢复窗口   : ${res.restoredWindows} 个已打开窗口已即时切回英文`);
      }
      if (res.purged.length > 0) {
        console.log(`  • 已额外清理   : ${res.purged.join(', ')}`);
      } else {
        console.log('  • 提示：已保留本地配置、翻译缓存与日志（如需一并清理，请运行 uninstall --purge）；重启 Antigravity 后调试端口将关闭。');
      }
      console.log('');
      return;
    }
    throw new Error('当前平台未安装系统常驻服务。');
  }

  if (opts.command === 'status') {
    const st =
      process.platform === 'win32'
        ? await getWinServiceStatus({ rootDir: ROOT, port: opts.port })
        : await getMacServiceStatus({ rootDir: ROOT, port: opts.port });
    console.log('\n=== antigravity-zh-lite 运行状态 ===');
    console.log(`  常驻服务已安装 : ${st.installed ? '是' : '否'}`);
    console.log(`  后台守护状态   : ${st.serviceLoaded ? '运行中' : '未运行'}`);
    console.log(`  自动跟随接管   : ${st.autoFollow ? '开启' : '关闭'}`);
    console.log(`  Antigravity进程: ${st.antigravityRunning ? '运行中' : '未运行'}`);
    console.log(`  CDP 调试端口   : ${st.cdpPort} (${st.cdpReachable ? '已就绪' : '未开启'})`);
    console.log(`  已发现 UI 窗口 : ${st.uiTargets.length} 个`);
    for (const title of st.uiTargets) {
      console.log(`    - ${title}`);
    }
    console.log(`  动态弹窗翻译   : ${st.dynamicTranslate}`);
    console.log(`  采集上传模式   : ${st.uploadMode}`);
    console.log(`  后台日志路径   : ${st.logPath}\n`);
    return;
  }

  if (opts.collect) {
    const n = await toggleCollectorInCdp({ port: opts.port, enabled: true });
    console.log(`[ag-zh] 已在 ${n} 个窗口开启未译词采集模式。浏览界面后点击右下角「结束」即可自动上传。`);
    return;
  }

  if (opts.dump) {
    const outputPath = path.join(ROOT, 'dicts', '_collected.json');
    const res = await dumpCollectedFromCdp({ port: opts.port, outputPath });
    console.log(`[ag-zh] 已导出 ${res.count} 条未翻译候选词条到: ${res.outputPath}`);
    return;
  }

  await runLauncher({ ...opts, rootDir: ROOT });
}

main().catch((err) => {
  console.error(`\n[ag-zh] 执行失败：${err.message}\n`);
  process.exit(1);
});
