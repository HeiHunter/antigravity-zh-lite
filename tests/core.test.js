import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createMatcher } from '../src/core/matcher.js';
import { createDynamicQueue } from '../src/core/dynamic.js';
import { createDomTranslator } from '../src/core/walker.js';
import { createCollector } from '../src/core/collector.js';
import { isAntigravityUiTarget, isChromiumCdpVersion } from '../src/cdp/client.js';
import {
  filterRemoteSafeEntries,
  formatUploadModeLabel,
  handleCollectedUpload,
  loadConfig,
} from '../src/cdp/uploader.js';
import {
  createDynamicTranslator,
  createSemaphore,
  isValidDynamicKey,
  redactSensitiveTokens,
  restoreSensitiveTokens,
} from '../src/cdp/translator.js';
import {
  parseMacScutilProxy,
  parseWinRegProxy,
  requestViaHttpProxy,
  smartFetch,
} from '../src/cdp/proxy.js';
import {
  applyMainFrameNavigation,
  createAutoFollowController,
  isAllowedBridgeCall,
  parseMacEtimeToSeconds,
  parseMacPsOutput,
  refreshSessionOnHotReload,
} from '../src/cdp/launcher.js';
import { createMacLauncherApp, generateLaunchAgentPlist } from '../src/macos/service.js';
import { generateWinDaemonVbs, generateWinShortcutScript } from '../src/win/service.js';
import { collectReleaseFiles } from '../scripts/pack-release.js';
import { buildAll } from '../scripts/build.js';

// Minimal mock DOM helpers for zero-dependency Node testing
function createText(value, parent = null) {
  return { nodeType: 3, nodeValue: value, parentElement: parent, isConnected: true };
}

function createEl(
  tagName,
  { attrs = {}, classes = [], children = [], contentEditable = false, shadowRoot = null } = {}
) {
  const attrMap = new Map(Object.entries(attrs));
  const el = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    id: attrs.id || '',
    isContentEditable: contentEditable,
    parentElement: null,
    childNodes: [],
    shadowRoot,
    isConnected: true,
    getAttribute(name) {
      return attrMap.has(name) ? attrMap.get(name) : null;
    },
    setAttribute(name, val) {
      attrMap.set(name, String(val));
    },
    removeAttribute(name) {
      attrMap.delete(name);
    },
    matches(selector) {
      return selector
        .split(',')
        .map((s) => s.trim())
        .some((part) => {
          if (part.startsWith('.')) return classes.includes(part.slice(1));
          if (part.startsWith('#')) return el.id === part.slice(1);
          const attrMatch = /^\[([\w-]+)(?:(\*)?="([^"]*)")?\]$/.exec(part);
          if (attrMatch) {
            const [, k, contains, v] = attrMatch;
            if (!attrMap.has(k)) return false;
            if (v === undefined) return true;
            return contains ? String(attrMap.get(k)).includes(v) : attrMap.get(k) === v;
          }
          return el.tagName === part.toUpperCase();
        });
    },
    closest(selector) {
      let cur = el;
      while (cur) {
        if (cur.matches && cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
  };
  for (const child of children) {
    child.parentElement = el;
    el.childNodes.push(child);
  }
  return el;
}

test('matcher: exact, scoped override, whitespace preservation, and patterns', () => {
  const matcher = createMatcher({
    exact: {
      Settings: '设置',
      Run: '执行记录',
    },
    scoped: [
      {
        selector: 'button',
        exact: { Run: '运行' },
      },
    ],
    patterns: [
      {
        hint: 'file',
        regex: '^(\\d+)\\s+files?\\s+changed$',
        flags: 'i',
        replace: '$1 个文件已变更',
      },
    ],
  });

  const btn = createEl('button');
  const div = createEl('div');

  assert.equal(matcher.translate('  Settings  ', div), '  设置  ');
  assert.equal(matcher.translate('Run', btn), '运行');
  assert.equal(matcher.translate('Run', div), '执行记录');
  assert.equal(matcher.translate('3 files changed', div), '3 个文件已变更');
  assert.equal(matcher.translate('1 file changed', div), '1 个文件已变更');
  assert.equal(matcher.translate('已经是中文', div), null);
  assert.equal(matcher.translate('12345', div), null);
});

test('walker: React-safe text & attribute translation, React re-render handling, and lossless restore', () => {
  const matcher = createMatcher({
    exact: {
      Settings: '设置',
      'Ask anything...': '输入你的任务或问题...',
      Send: '发送',
    },
    patterns: [
      {
        hint: 'file',
        regex: '^(\\d+)\\s+files?\\s+changed$',
        flags: 'i',
        replace: '$1 个文件已变更',
      },
    ],
  });

  const translator = createDomTranslator(matcher, {
    ignoreSelectors: ['.markdown-body'],
  });

  const labelText = createText('Settings');
  const countText = createText('2 files changed');
  const codeText = createText('Settings');
  const proseText = createText('Settings');
  const inputEl = createEl('input', {
    attrs: { placeholder: 'Ask anything...', 'aria-label': 'Send', value: 'Settings' },
  });

  const root = createEl('div', {
    children: [
      createEl('span', { children: [labelText] }),
      createEl('span', { children: [countText] }),
      createEl('code', { children: [codeText] }),
      createEl('div', { classes: ['markdown-body'], children: [proseText] }),
      inputEl,
    ],
  });

  translator.translateSubtree(root);
  assert.equal(labelText.nodeValue, '设置');
  assert.equal(countText.nodeValue, '2 个文件已变更');
  assert.equal(codeText.nodeValue, 'Settings');
  assert.equal(proseText.nodeValue, 'Settings');
  assert.equal(inputEl.getAttribute('placeholder'), '输入你的任务或问题...');
  assert.equal(inputEl.getAttribute('aria-label'), '发送');
  assert.equal(inputEl.getAttribute('value'), 'Settings');

  countText.nodeValue = '5 files changed';
  translator.translateTextNode(countText);
  assert.equal(countText.nodeValue, '5 个文件已变更');

  translator.restoreSubtree(root);
  assert.equal(labelText.nodeValue, 'Settings');
  assert.equal(countText.nodeValue, '5 files changed');
  assert.equal(inputEl.getAttribute('placeholder'), 'Ask anything...');
  assert.equal(inputEl.getAttribute('aria-label'), 'Send');
});

test('collector: captures clean UI strings, notifies onChange, and filters noise', () => {
  const counts = [];
  const collector = createCollector((n) => counts.push(n));
  collector.enabled = true;
  const btn = createEl('button', { attrs: { role: 'button' } });

  collector.record('New Workflow', btn);
  collector.record('New Workflow', btn);
  collector.record('https://example.com/docs', btn);
  collector.record('/Users/me/project/file.ts', btn);
  collector.record('const x = () => {};', btn);
  collector.record('中文内容', btn);

  const items = collector.getItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'New Workflow');
  assert.equal(items[0].count, 2);
  assert.deepEqual(counts, [1]);
  assert.deepEqual(collector.exportDictTemplate(), { exact: { 'New Workflow': '' } });
});

test('cdp target filter: allows Antigravity UI targets and blocks dev previews, external pages, and devtools', () => {
  assert.equal(isChromiumCdpVersion({ Browser: 'Chrome/132.0.0.0' }), true);
  assert.equal(isChromiumCdpVersion({ Browser: 'node.js/v22.12.0' }), false);

  assert.equal(
    isAntigravityUiTarget({
      type: 'page',
      url: 'file:///Applications/Antigravity.app/Contents/Resources/app/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:19229/devtools/page/1',
    }),
    true
  );
  // Arbitrary local HTML file must NOT be injected even if title spoofs "Antigravity"
  assert.equal(
    isAntigravityUiTarget({
      type: 'page',
      url: 'file:///Users/alice/projects/demo/index.html',
      title: 'Antigravity Demo',
      webSocketDebuggerUrl: 'ws://127.0.0.1:19229/devtools/page/1b',
    }),
    false
  );
  // Antigravity 2.0 local HTTPS UI server (including cold-start token URL)
  assert.equal(
    isAntigravityUiTarget({
      type: 'page',
      url: 'https://127.0.0.1:60912/#t=66e66d1a391a0c3bb34173a55da6bb23',
      webSocketDebuggerUrl: 'ws://127.0.0.1:19229/devtools/page/2',
    }),
    true
  );
  // Host prefix spoofing & user HTTPS localhost dev server must NOT be injected
  assert.equal(
    isAntigravityUiTarget({
      type: 'page',
      url: 'https://127.0.0.1.evil.com:8443/chat',
      title: 'Antigravity',
      webSocketDebuggerUrl: 'ws://127.0.0.1:19229/devtools/page/2a',
    }),
    false
  );
  assert.equal(
    isAntigravityUiTarget({
      type: 'page',
      url: 'https://localhost:5173/dashboard',
      title: 'Antigravity Preview',
      webSocketDebuggerUrl: 'ws://127.0.0.1:19229/devtools/page/2aa',
    }),
    false
  );
  // Plain http://localhost dev server preview must NOT be injected even with spoofed title
  assert.equal(
    isAntigravityUiTarget({
      type: 'page',
      url: 'http://localhost:3000/dashboard',
      title: 'Workspace - Antigravity',
      webSocketDebuggerUrl: 'ws://127.0.0.1:19229/devtools/page/2b',
    }),
    false
  );
  // Cross-version HTTP fallback requires 127.0.0.1 + port + Antigravity path + Antigravity title
  assert.equal(
    isAntigravityUiTarget({
      type: 'page',
      url: 'http://127.0.0.1:60912/c/abc-123',
      title: 'Workspace - Antigravity',
      webSocketDebuggerUrl: 'ws://127.0.0.1:19229/devtools/page/2c',
    }),
    true
  );
  assert.equal(
    isAntigravityUiTarget({
      type: 'page',
      url: 'http://127.0.0.1:3000/admin/users',
      title: 'Antigravity Admin',
      webSocketDebuggerUrl: 'ws://127.0.0.1:19229/devtools/page/2d',
    }),
    false
  );
  assert.equal(
    isAntigravityUiTarget({
      type: 'page',
      url: 'https://github.com/google/antigravity',
      webSocketDebuggerUrl: 'ws://127.0.0.1:19229/devtools/page/3',
    }),
    false
  );
  assert.equal(
    isAntigravityUiTarget({
      type: 'page',
      url: 'devtools://devtools/bundled/inspector.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:19229/devtools/page/4',
    }),
    false
  );
});

test('uploader: saves and incrementally merges collected entries into dicts/_collected.json', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-zh-upload-'));
  try {
    const res1 = await handleCollectedUpload({
      rootDir: tmpRoot,
      payload: { exact: { 'First Label': '' } },
      config: { upload: { mode: 'local', mergeLocal: true } },
    });
    assert.equal(res1.ok, true);
    assert.equal(res1.incomingCount, 1);
    assert.equal(res1.totalCount, 1);

    const res2 = await handleCollectedUpload({
      rootDir: tmpRoot,
      payload: { exact: { 'Second Label': '' } },
      config: { upload: { mode: 'local', mergeLocal: true } },
    });
    assert.equal(res2.ok, true);
    assert.equal(res2.incomingCount, 1);
    assert.equal(res2.totalCount, 2);

    const saved = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'dicts', '_collected.json'), 'utf8'));
    assert.deepEqual(saved, { exact: { 'First Label': '', 'Second Label': '' } });

    // Regression: mode === 'local' must NEVER trigger webhook even if webhookUrl is set
    const resLocalWithWebhook = await handleCollectedUpload({
      rootDir: tmpRoot,
      payload: { exact: { 'Third Label': '' } },
      config: {
        upload: {
          mode: 'local',
          mergeLocal: true,
          webhookUrl: 'http://127.0.0.1:1/should-not-be-called',
        },
      },
    });
    assert.equal(resLocalWithWebhook.remoteStatus, 'local-only');
    assert.equal(formatUploadModeLabel({ mode: 'local', webhookUrl: 'https://example.com' }), 'local');
    assert.equal(
      formatUploadModeLabel({ mode: 'webhook', webhookUrl: 'https://example.com' }),
      'webhook (https://example.com)'
    );

    // Regression: corrupted ag-zh.config.json must fail-closed (disable online translation & remote upload)
    fs.writeFileSync(path.join(tmpRoot, 'ag-zh.config.json'), '{ invalid json,,,', 'utf8');
    const safeCfg = loadConfig(tmpRoot);
    assert.equal(safeCfg.dynamicTranslate.enabled, false);
    assert.equal(safeCfg.autoFollow, false);
    assert.equal(safeCfg.upload.mode, 'local');
    assert.equal(safeCfg.upload.webhookUrl, '');
    assert.ok(safeCfg._configError);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('macos service: generates valid LaunchAgent plist and native .app launcher bundle', () => {
  const plist = generateLaunchAgentPlist({
    nodePath: '/opt/homebrew/bin/node',
    binPath: '/tmp/repo/bin/ag-zh.js',
    rootDir: '/tmp/repo',
    port: 9229,
    logDir: '/tmp/logs',
  });
  assert.ok(plist.includes('<string>com.antigravity.zh-lite</string>'));
  assert.ok(plist.includes('<string>--daemon</string>'));
  assert.ok(plist.includes('<key>RunAtLoad</key>\n  <true/>'));
  assert.ok(plist.includes('<key>KeepAlive</key>\n  <true/>'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-zh-app-'));
  try {
    const appPath = path.join(tmpDir, 'Antigravity 中文版.app');
    createMacLauncherApp({
      appBundlePath: appPath,
      antigravityAppPath: '/Applications/Antigravity.app',
      port: 9229,
    });
    const info = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    const launcher = fs.readFileSync(path.join(appPath, 'Contents', 'MacOS', 'launcher'), 'utf8');
    assert.ok(info.includes('Antigravity 中文版'));
    assert.ok(launcher.includes('--remote-debugging-port='));
    assert.ok(launcher.includes('/Contents/MacOS/Antigravity'));
    assert.ok(!launcher.includes('pgrep -x'));
    if (process.platform !== 'win32') {
      assert.equal((fs.statSync(path.join(appPath, 'Contents', 'MacOS', 'launcher')).mode & 0o111) !== 0, true);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.equal(parseMacEtimeToSeconds('00:08'), 8);
  assert.equal(parseMacEtimeToSeconds('02:15'), 135);
  assert.equal(parseMacEtimeToSeconds('01:02:03'), 3723);
  assert.equal(parseMacEtimeToSeconds('2-03:04:05'), 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.equal(parseMacEtimeToSeconds('invalid'), null);

  // Regression: Antigravity Helper.app inside /Contents/Frameworks/ must NOT match as main process
  const parsedMacProcs = parseMacPsOutput([
    '35791 02:43:39 /Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=9229',
    '35829 02:43:34 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --import=main.mjs',
    '35830 02:43:34 /Applications/Antigravity.app/Contents/MacOS/Antigravity --type=renderer',
  ].join('\n'));
  assert.deepEqual(
    parsedMacProcs.map((p) => p.pid),
    [35791]
  );
});

test('build: generates valid zero-dependency injector IIFE and handles bridge upload flow in VM', () => {
  const built = buildAll();
  const code = fs.readFileSync(built.injectorPath, 'utf8');
  const dictSizeKB = Buffer.byteLength(fs.readFileSync(built.dictPath, 'utf8'), 'utf8') / 1024;
  const engineOnlyKB = Number(built.sizeKB) - dictSizeKB;
  assert.ok(engineOnlyKB < 45, `Expected lightweight engine (<45 KB unminified), got ${engineOnlyKB.toFixed(1)} KB`);
  assert.ok(Number(built.sizeKB) < 250, `Expected compact total bundle, got ${built.sizeKB} KB`);

  const bridgedMessages = [];
  const sandbox = {
    window: {},
    console,
    __AG_ZH_BRIDGE__(payload) {
      bridgedMessages.push(JSON.parse(payload));
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox);

  assert.ok(sandbox.__AG_ZH__, 'Expected window.__AG_ZH__ API to be initialized');
  const state = sandbox.__AG_ZH__.getState();
  assert.equal(state.enabled, true);
  assert.ok(state.dictStats.exact >= 400);

  // Verify start -> finish & auto-upload flow through __AG_ZH_BRIDGE__
  sandbox.__AG_ZH__.startCollection();
  assert.equal(sandbox.__AG_ZH__.getState().collecting, true);
  const emptyFinish = sandbox.__AG_ZH__.finishAndUploadCollection();
  assert.equal(emptyFinish.count, 0);
  assert.equal(bridgedMessages.length, 0);

  // Top-frame guard: child iframe (self !== top) must NOT initialize window.__AG_ZH__
  const iframeSandbox = { window: {}, console, top: { isParent: true } };
  iframeSandbox.window = iframeSandbox;
  iframeSandbox.self = iframeSandbox;
  vm.runInNewContext(code, iframeSandbox);
  assert.equal(iframeSandbox.__AG_ZH__, undefined);
});

test('approval dialog: translates split React fragments statically and queues dynamic risk text only inside card', async () => {
  const dict = JSON.parse(fs.readFileSync(new URL('../dist/dict.json', import.meta.url), 'utf8'));
  const matcher = createMatcher(dict);
  const queuedBatches = [];
  let translator;

  const dynamicQueue = createDynamicQueue({
    sendRequest(batch) {
      queuedBatches.push(batch);
    },
    onApplyNodes(nodes) {
      for (const n of nodes) translator.translateTextNode(n);
    },
  });

  translator = createDomTranslator(matcher, {
    ignoreSelectors: dict.ignoreSelectors,
    dynamicQueue,
  });

  const titleText = createText('Allow reload macOS LaunchAgent resident service?');
  const riskText = createText(
    'scripts/diagnose.js connects to the running Antigravity application over CDP on port 9229.'
  );
  const cmdText = createText('node bin/ag-zh.js install');
  const opt1Text = createText('Yes, allow this time');
  const opt2Prefix = createText("Yes, and always allow '");
  const opt2Cmd = createText('node bin/ag-zh.js install');
  const opt2Suffix = createText("' in this conversation");
  const skipText = createText('Skip');
  const outsideChatText = createText('Hello friend, this is a regular English chat paragraph outside any card.');

  const card = createEl('div', {
    children: [
      createEl('div', { children: [titleText] }),
      createEl('p', { children: [riskText] }),
      createEl('code', { children: [cmdText] }),
      createEl('div', { children: [opt1Text] }),
      createEl('div', {
        children: [opt2Prefix, createEl('strong', { children: [opt2Cmd] }), opt2Suffix],
      }),
      createEl('button', { children: [skipText] }),
    ],
  });
  Object.defineProperty(card, 'textContent', {
    get: () => 'Allow reload macOS LaunchAgent resident service? Yes, allow this time Skip Submit',
  });

  const pageRoot = createEl('div', {
    children: [card, createEl('p', { children: [outsideChatText] })],
  });

  translator.translateSubtree(pageRoot);

  // Static approval fragments translate synchronously (0ms)
  assert.equal(opt1Text.nodeValue, '是，仅本次允许');
  assert.equal(opt2Prefix.nodeValue, "是，并始终允许 '");
  assert.equal(opt2Cmd.nodeValue, 'node bin/ag-zh.js install');
  assert.equal(opt2Suffix.nodeValue, "'（仅当前对话）");
  assert.equal(skipText.nodeValue, '跳过');
  assert.equal(cmdText.nodeValue, 'node bin/ag-zh.js install');

  // Wait for 100ms dynamic queue debounce
  await new Promise((r) => setTimeout(r, 140));
  assert.equal(queuedBatches.length, 1);
  assert.ok(queuedBatches[0].includes('Allow reload macOS LaunchAgent resident service?'));
  assert.ok(
    queuedBatches[0].includes(
      'scripts/diagnose.js connects to the running Antigravity application over CDP on port 9229.'
    )
  );
  // Regular chat prose outside approval card must NEVER be sent for dynamic translation
  assert.ok(!queuedBatches[0].includes(outsideChatText.nodeValue));

  // Verify model names and short menu items inside [role="menu"] are NEVER dynamically translated
  const menuEl = createEl('div', { attrs: { role: 'menu' } });
  assert.equal(dynamicQueue.isEligible('Gemini 4 Neon', menuEl), false);
  assert.equal(dynamicQueue.isEligible('Gemini 4 Neon High', menuEl), false);
  assert.equal(dynamicQueue.isEligible('Claude Opus 5.5', menuEl), false);
  assert.equal(dynamicQueue.isEligible('Claude Sonnet 5.5', menuEl), false);
  assert.equal(dynamicQueue.isEligible('GPT-OSS 120B (Medium)', menuEl), false);
  assert.equal(dynamicQueue.isEligible('Google Sans', menuEl), false);
  assert.equal(dynamicQueue.isEligible('Leaving Soon', menuEl), false);
  assert.equal(dynamicQueue.isEligible('Select Model', menuEl), false);
  // Long explanatory sentence (>= 5 words, >= 28 chars) inside a menu/dialog IS eligible
  assert.equal(
    dynamicQueue.isEligible(
      'This model will be retired next month and replaced by a newer version.',
      menuEl
    ),
    true
  );

  // Marketplace shelf: long plugin description IS eligible, short plugin brand name is NOT
  const shelfEl = createEl('div', { attrs: { 'aria-label': 'Plugins in Developer Tools' } });
  assert.equal(dynamicQueue.isEligible('Datadog', shelfEl), false);
  assert.equal(dynamicQueue.isEligible('CrowdStrike Falcon', shelfEl), false);
  assert.equal(
    dynamicQueue.isEligible(
      'Query traces, datasets, and experiments with built-in evaluation skills.',
      shelfEl
    ),
    true
  );

  // Simulate daemon returning dynamic translations -> in-place React-safe apply + lossless restore
  const dynamicReply = {
    'Allow reload macOS LaunchAgent resident service?': '允许重新加载 macOS LaunchAgent 常驻服务吗？',
    'scripts/diagnose.js connects to the running Antigravity application over CDP on port 9229.':
      'scripts/diagnose.js 将通过 9229 端口的 CDP 连接正在运行的 Antigravity 应用。',
  };
  matcher.addDynamicBatch(dynamicReply);
  dynamicQueue.receiveTranslations(dynamicReply);

  assert.equal(titleText.nodeValue, '允许重新加载 macOS LaunchAgent 常驻服务吗？');
  assert.equal(
    riskText.nodeValue,
    'scripts/diagnose.js 将通过 9229 端口的 CDP 连接正在运行的 Antigravity 应用。'
  );

  // Lossless restore back to English works for dynamic translations too!
  translator.restoreSubtree(pageRoot);
  assert.equal(titleText.nodeValue, 'Allow reload macOS LaunchAgent resident service?');
  assert.equal(
    riskText.nodeValue,
    'scripts/diagnose.js connects to the running Antigravity application over CDP on port 9229.'
  );
});

test('daemon dynamic translator: caches translations to disk and reuses cache without refetching', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-zh-dyn-'));
  try {
    let calls = 0;
    const t1 = createDynamicTranslator({
      rootDir: tmpRoot,
      config: { dynamicTranslate: { enabled: true } },
      customTranslateFn: async (text) => {
        calls++;
        return `译:${text}`;
      },
    });

    const sample = 'The command runs a full integration test suite.';
    const r1 = await t1.translateTexts([sample]);
    assert.equal(calls, 1);
    assert.equal(r1.fetched, 1);
    assert.equal(r1.fromCache, 0);
    assert.equal(r1.translations[sample], `译:${sample}`);

    const r2 = await t1.translateTexts([sample]);
    assert.equal(calls, 1);
    assert.equal(r2.fetched, 0);
    assert.equal(r2.fromCache, 1);

    t1.flushCacheSync();

    // New instance loads persisted cache from dicts/_dynamic_cache.json
    const t2 = createDynamicTranslator({
      rootDir: tmpRoot,
      config: { dynamicTranslate: { enabled: true } },
      customTranslateFn: async () => {
        throw new Error('Should not fetch when cached on disk');
      },
    });
    const r3 = await t2.translateTexts([sample]);
    assert.equal(r3.fromCache, 1);
    assert.equal(r3.translations[sample], `译:${sample}`);

    // Regression: negative maxCacheSize must NOT hang flushCacheSync()
    t2.flushCacheSync(-1);
    assert.equal(t2.getCacheSize(), 1);
    t2.flushCacheSync(0);
    assert.equal(t2.getCacheSize(), 0);

    // Regression: translateTexts() enforces isValidDynamicKey() on backend (rejects model names / short labels)
    const rejected = await t1.translateTexts(['Gemini 4 Neon', 'Short label']);
    assert.deepEqual(rejected.translations, {});
    assert.equal(isValidDynamicKey('Gemini 4 Neon'), false);

    // Regression: placeholder redaction & strict restoration
    const rawRisk =
      "The command runs `node bin/ag-zh.js` and writes files in ~/Library/LaunchAgents using 'install'.";
    const { redacted, tokens } = redactSensitiveTokens(rawRisk);
    assert.ok(!redacted.includes('~/Library/LaunchAgents'));
    assert.ok(!redacted.includes('`node bin/ag-zh.js`'));
    assert.ok(tokens.length >= 2);
    assert.equal(restoreSensitiveTokens(redacted, tokens), rawRisk);
    // Corrupted placeholder must fail safely and return null instead of rendering broken tokens
    assert.equal(restoreSensitiveTokens('翻译后的文本漏掉了占位符', tokens), null);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dynamicQueue: retries after cooldown on failure and prunes disconnected nodes', async () => {
  const batches = [];
  const dq = createDynamicQueue({
    sendRequest(batch) {
      batches.push(batch);
    },
    retryCooldownMs: 30,
    maxAttempts: 2,
  });

  const sentence = 'The command modifies files outside the current workspace directory.';
  const el = createEl('div', { attrs: { role: 'dialog' } });
  const n1 = createText(sentence, el);
  dq.enqueue(sentence, n1, el);
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(batches.length, 1);

  // Wait past cooldown, simulate retry with a fresh connected node while n1 disconnected
  n1.isConnected = false;
  await new Promise((r) => setTimeout(r, 40));
  const n2 = createText(sentence, el);
  dq.enqueue(sentence, n2, el);
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(batches.length, 2);

  // Max attempts reached -> no 3rd retry until resolved
  await new Promise((r) => setTimeout(r, 40));
  dq.enqueue(sentence, n2, el);
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(batches.length, 2);

  // Disconnected node pruning drops empty entries cleanly
  n2.isConnected = false;
  dq.pruneStalePending();
  assert.equal(dq.getPendingSize(), 0);
});

test('proxy parser: extracts macOS scutil and Windows registry HTTP proxies', () => {
  const macOut = `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
}`;
  assert.equal(parseMacScutilProxy(macOut), 'http://127.0.0.1:7890');
  assert.equal(parseMacScutilProxy('HTTPSEnable : 0\nHTTPEnable : 0'), null);

  assert.equal(
    parseWinRegProxy(
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    127.0.0.1:10809'
    ),
    'http://127.0.0.1:10809'
  );
  assert.equal(
    parseWinRegProxy(
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891'
    ),
    'http://127.0.0.1:7891'
  );
  assert.equal(
    parseWinRegProxy(
      '    ProxyEnable    REG_DWORD    0x0',
      '    ProxyServer    REG_SZ    127.0.0.1:7890'
    ),
    null
  );
});

test('smartFetch: direct request timeout covers slow response body read', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { signal }) => ({
    status: 200,
    statusText: 'OK',
    text() {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Body read aborted by timeout')), {
          once: true,
        });
      });
    },
  });
  try {
    await assert.rejects(
      () => smartFetch('http://example.invalid/slow-body', {}, { timeoutMs: 40 }),
      /aborted by timeout/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('windows service: generates hidden VBS daemon launcher and native .lnk PowerShell script', () => {
  const vbs = generateWinDaemonVbs({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    binPath: 'D:\\tools\\antigravity-zh\\bin\\ag-zh.js',
    port: 9229,
    logPath: 'C:\\Users\\Alice\\AppData\\Local\\antigravity-zh-lite\\daemon.log',
  });
  assert.ok(vbs.includes('CreateObject("WScript.Shell")'));
  assert.ok(vbs.includes('--daemon --port 9229'));
  assert.ok(vbs.includes(', 0, False'));

  const ps = generateWinShortcutScript({
    shortcutPath: 'C:\\Users\\Alice\\Desktop\\Antigravity 中文版.lnk',
    targetExe: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
    port: 9229,
  });
  assert.ok(ps.includes('--remote-debugging-port=9229'));
  assert.ok(ps.includes('Antigravity.exe,0'));
});

test('release packager: excludes private caches, local config, and personal files', () => {
  const files = collectReleaseFiles();
  assert.ok(files.includes('package.json'));
  assert.ok(files.includes('LICENSE'));
  assert.ok(files.includes('README.md'));
  assert.ok(files.includes('启动汉化.command'));
  assert.ok(files.includes('启动汉化.bat'));
  assert.ok(files.includes('src/win/service.js'));
  assert.ok(files.includes('src/macos/service.js'));
  assert.ok(files.includes('src/cdp/proxy.js'));

  assert.ok(!files.some((f) => f.startsWith('dicts/_')));
  assert.ok(!files.includes('ag-zh.config.json'));
  assert.ok(!files.some((f) => f.endsWith('.DS_Store')));
});

test('cdp session lifecycle: navigation, execution context isolation, and hot-reload preload refresh', async () => {
  const session = {
    url: 'https://127.0.0.1:60912/c/conv-1',
    title: 'Antigravity',
    mainFrameId: 'frame-main',
    mainContextId: 7,
    newDocScriptId: 'script-v1',
    client: null,
  };

  // Matching top-level default execution context is allowed
  assert.equal(
    isAllowedBridgeCall(session, {
      name: '__AG_ZH_BRIDGE__',
      payload: JSON.stringify({ type: 'translate_dynamic', texts: [] }),
      executionContextId: 7,
    }),
    true
  );

  // Non-main execution context (e.g. child iframe or isolated world) is rejected
  assert.equal(
    isAllowedBridgeCall(session, {
      name: '__AG_ZH_BRIDGE__',
      payload: JSON.stringify({ type: 'translate_dynamic', texts: [] }),
      executionContextId: 99,
    }),
    false
  );

  // Oversized payload (> 256 KB) is rejected
  assert.equal(
    isAllowedBridgeCall(session, {
      name: '__AG_ZH_BRIDGE__',
      payload: 'x'.repeat(260 * 1024),
      executionContextId: 7,
    }),
    false
  );

  // Child frame navigation must NOT alter main session URL
  assert.equal(
    applyMainFrameNavigation(session, {
      frame: { id: 'frame-child', parentId: 'frame-main', url: 'https://evil.example/' },
    }),
    false
  );
  assert.equal(session.url, 'https://127.0.0.1:60912/c/conv-1');

  // Top-level navigation to external page blocks both re-injection and bridge calls
  assert.equal(
    applyMainFrameNavigation(session, {
      frame: { id: 'frame-main', url: 'https://github.com/HeiHunter/antigravity-zh-lite' },
    }),
    false
  );
  assert.equal(
    isAllowedBridgeCall(session, {
      name: '__AG_ZH_BRIDGE__',
      payload: JSON.stringify({ type: 'translate_dynamic', texts: [] }),
      executionContextId: 7,
    }),
    false
  );

  // Hot-reload revokes old preload script before registering new preload script and updates live dict
  const calls = [];
  session.client = {
    isOpen: () => true,
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        return { identifier: 'script-v2' };
      }
      return { result: { value: true } };
    },
  };
  const reloaded = await refreshSessionOnHotReload(session, '/* v2 */', '{"exact":{"Hi":"你好"}}');
  assert.equal(reloaded, true);
  assert.equal(session.newDocScriptId, 'script-v2');
  assert.deepEqual(
    calls.map((c) => c.method),
    [
      'Page.removeScriptToEvaluateOnNewDocument',
      'Page.addScriptToEvaluateOnNewDocument',
      'Runtime.evaluate',
    ]
  );
  assert.equal(calls[0].params.identifier, 'script-v1');
  assert.equal(calls[1].params.source, '/* v2 */');
});

test('translator: no implicit cross-provider fallback and bounded semaphore queue', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-zh-nofallback-'));
  const origFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      async text() {
        return 'upstream error';
      },
    };
  };
  try {
    const sample = 'The command modifies files outside the workspace directory safely.';
    const t = createDynamicTranslator({ rootDir: tmpRoot });

    // OpenAI failure must NEVER silently fall back to Google or MyMemory
    const rOpenAi = await t.translateTexts([sample], {
      dynamicTranslate: { enabled: true, provider: 'openai', apiKey: 'sk-test-only', proxy: 'none' },
    });
    assert.deepEqual(rOpenAi.translations, {});
    assert.ok(requestedUrls.length > 0 && requestedUrls.every((u) => u.includes('/chat/completions')));
    assert.ok(!requestedUrls.some((u) => u.includes('translate.googleapis.com') || u.includes('mymemory')));

    requestedUrls.length = 0;
    // Gemini failure must NEVER silently fall back to Google Translate or MyMemory
    const rGemini = await t.translateTexts([sample], {
      dynamicTranslate: { enabled: true, provider: 'gemini', apiKey: 'test-key', proxy: 'none' },
    });
    assert.deepEqual(rGemini.translations, {});
    assert.ok(requestedUrls.length > 0 && requestedUrls.every((u) => u.includes('generativelanguage.googleapis.com')));
    assert.ok(!requestedUrls.some((u) => u.includes('translate.googleapis.com') || u.includes('mymemory')));

    requestedUrls.length = 0;
    // Google failure must NEVER silently fall back to MyMemory
    const rGoogle = await t.translateTexts([sample], {
      dynamicTranslate: { enabled: true, provider: 'google', proxy: 'none' },
    });
    assert.deepEqual(rGoogle.translations, {});
    assert.ok(requestedUrls.length > 0 && requestedUrls.every((u) => u.includes('translate.googleapis.com')));
    assert.ok(!requestedUrls.some((u) => u.includes('mymemory')));

    // Semaphore rejects excess tasks once waiting queue reaches maxQueueSize
    const withPermit = createSemaphore(1, 2);
    let releaseFirst;
    const holdFirst = withPermit(() => new Promise((r) => { releaseFirst = r; }));
    const queued1 = withPermit(async () => 'q1');
    const queued2 = withPermit(async () => 'q2');
    await assert.rejects(() => withPermit(async () => 'overflow'), /queue full/i);
    releaseFirst('first');
    assert.deepEqual(await Promise.all([holdFirst, queued1, queued2]), ['first', 'q1', 'q2']);
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('uploader: filters embedded sensitive entries before remote upload without altering local save', async () => {
  const { safe, filteredCount } = filterRemoteSafeEntries({
    'Open Command Palette': '',
    'Inspect ~/Library/LaunchAgents/com.test.plist now': '',
    'Contact alice@example.com for token ghp_1234567890abcdef1234': '',
  });
  assert.deepEqual(safe, { 'Open Command Palette': '' });
  assert.equal(filteredCount, 2);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-zh-sens-'));
  try {
    const res = await handleCollectedUpload({
      rootDir: tmpRoot,
      payload: { exact: { 'Read /Users/alice/secret.env file': '' } },
      config: { upload: { mode: 'webhook', webhookUrl: 'http://127.0.0.1:1/never-called' } },
    });
    assert.equal(res.remoteStatus, 'skipped-sensitive');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('proxy tunnel: destroys hanging HTTP CONNECT socket cleanly on timeout', async () => {
  let serverPeerEnded = false;
  const openSockets = new Set();
  const proxyServer = http.createServer();
  proxyServer.on('connect', (_req, clientSocket) => {
    openSockets.add(clientSocket);
    clientSocket.on('end', () => {
      serverPeerEnded = true;
      clientSocket.end();
    });
    clientSocket.on('close', () => {
      serverPeerEnded = true;
      openSockets.delete(clientSocket);
    });
    clientSocket.resume();
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    // Intentionally stall without completing TLS handshake
  });

  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  const addr = proxyServer.address();
  const proxyUrl = `http://127.0.0.1:${addr.port}`;

  try {
    await assert.rejects(
      () => requestViaHttpProxy('https://example.invalid/slow', {}, proxyUrl, 60),
      /Proxy request timeout/
    );
    for (let i = 0; i < 20 && !serverPeerEnded; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(serverPeerEnded, true, 'Expected hanging proxy tunnel socket to be destroyed on timeout');
  } finally {
    for (const s of openSockets) s.destroy();
    proxyServer.close();
  }
});

test('auto-follow controller: handles query errors, pre-existing PIDs, grace-period races, and single-PID kill', async () => {
  const killed = [];
  let spawned = 0;
  let cdpOpen = false;
  let currentProcs = [{ pid: 100, uptimeSec: 200, args: '/Applications/Antigravity.app/Contents/MacOS/Antigravity' }];
  let fakeNow = 100000;

  const ctrl = createAutoFollowController({
    getProcs: async () => currentProcs,
    isCdpOpen: async () => cdpOpen,
    quitByPid: async (pid) => {
      killed.push(pid);
      return true;
    },
    spawnApp: () => {
      spawned++;
    },
    sleep: async () => {},
    now: () => fakeNow,
    initialPids: [100],
    log: () => {},
    warn: () => {},
  });

  // Query error (null) must NOT clear ignoredPreExistingPids
  currentProcs = null;
  await ctrl.check();
  assert.equal(ctrl.ignoredPreExistingPids.has(100), true);

  // Old process (> 15s uptime) is never killed
  currentProcs = [{ pid: 101, uptimeSec: 60, args: '/Applications/Antigravity.app/Contents/MacOS/Antigravity' }];
  await ctrl.check();
  assert.deepEqual(killed, []);

  // Grace-period race: CDP opens while waiting -> abort quit
  let step = 0;
  const raceCtrl = createAutoFollowController({
    getProcs: async () => [{ pid: 202, uptimeSec: 2, args: '/Applications/Antigravity.app/Contents/MacOS/Antigravity' }],
    isCdpOpen: async () => step > 0,
    quitByPid: async (pid) => {
      killed.push(pid);
      return true;
    },
    spawnApp: () => {
      spawned++;
    },
    sleep: async () => {
      step++;
    },
    now: () => 200000,
    log: () => {},
    warn: () => {},
  });
  await raceCtrl.check();
  assert.deepEqual(killed, []);
  assert.equal(spawned, 0);

  // Valid newly launched PID kills ONLY that PID (never pre-existing PID 100)
  fakeNow = 300000;
  currentProcs = [
    { pid: 100, uptimeSec: 300, args: '/Applications/Antigravity.app/Contents/MacOS/Antigravity' },
    { pid: 303, uptimeSec: 3, args: '/Applications/Antigravity.app/Contents/MacOS/Antigravity' },
  ];
  await ctrl.check();
  assert.deepEqual(killed, [303]);
  assert.equal(spawned, 1);
});

test('uninstall reload guard: post-uninstall session sentinel blocks preload re-injection until active reinstall', () => {
  const built = buildAll();
  const code = fs.readFileSync(built.injectorPath, 'utf8');
  const store = new Map([['__ag_zh_uninstalled__', '1']]);
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  // Reloading tab while __ag_zh_uninstalled__ === '1' must NOT re-initialize engine
  const reloadSandbox = { window: {}, console, sessionStorage };
  reloadSandbox.window = reloadSandbox;
  vm.runInNewContext(code, reloadSandbox);
  assert.equal(reloadSandbox.__AG_ZH__, undefined);

  // Active reinstall clears the sentinel and mounts cleanly again
  sessionStorage.removeItem('__ag_zh_uninstalled__');
  const reinstallSandbox = { window: {}, console, sessionStorage };
  reinstallSandbox.window = reinstallSandbox;
  vm.runInNewContext(code, reinstallSandbox);
  assert.ok(reinstallSandbox.__AG_ZH__);
});
