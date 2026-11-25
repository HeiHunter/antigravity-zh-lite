#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpClient, isAntigravityUiTarget, listCdpTargets } from '../src/cdp/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const port = Number(process.argv[2] || 9229);

const SCAN_EXPR = `(() => {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','CODE','PRE','TEXTAREA','SVG','MATH','CANVAS','IFRAME','KBD']);
  const IGNORE_SEL = '#ag-zh-host, [data-ag-zh-ignore], .xterm, .monaco-editor, .cm-editor, .markdown-body, .prose, [data-message-content], [contenteditable="true"]';
  const HAS_EN = /[A-Za-z]{2,}/;
  const HAS_CJK = /[\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef]/;
  const seen = new Set();
  const items = [];
  function walk(node) {
    if (!node) return;
    if (node.nodeType === 1) {
      if (SKIP.has(node.tagName)) return;
      if (node.closest && node.closest(IGNORE_SEL)) return;
      for (const attr of ['placeholder', 'title', 'aria-label']) {
        const v = (node.getAttribute && node.getAttribute(attr) || '').trim();
        if (v && v.length >= 2 && v.length <= 320 && HAS_EN.test(v) && !HAS_CJK.test(v) && !seen.has(v)) {
          seen.add(v);
          items.push(v);
        }
      }
      if (node.shadowRoot && node.id !== 'ag-zh-host') walk(node.shadowRoot);
    } else if (node.nodeType === 3) {
      const v = (node.nodeValue || '').trim();
      if (v && v.length >= 2 && v.length <= 320 && HAS_EN.test(v) && !HAS_CJK.test(v) && !seen.has(v)) {
        seen.add(v);
        items.push(v);
      }
      return;
    }
    const kids = node.childNodes;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) walk(kids[i]);
  }
  walk(document.body);
  return { url: location.href, count: items.length, items };
})()`;

const targets = (await listCdpTargets(port)).filter(isAntigravityUiTarget);
if (targets.length === 0) {
  console.error(`No Antigravity UI targets on port ${port}`);
  process.exit(1);
}

const merged = new Set();
for (const t of targets) {
  const client = new CdpClient(t.webSocketDebuggerUrl);
  await client.connect();
  const res = await client.send('Runtime.evaluate', {
    expression: SCAN_EXPR,
    returnByValue: true,
  });
  const val = res?.result?.value;
  if (val && Array.isArray(val.items)) {
    console.log(`Scanned ${val.url}: ${val.items.length} untranslated items`);
    for (const item of val.items) merged.add(item);
  }
  client.close();
}

const outPath = path.join(ROOT, 'dicts', '_screen_scan.json');
fs.writeFileSync(outPath, JSON.stringify([...merged], null, 2) + '\n', 'utf8');
console.log(`Saved ${merged.size} items to ${outPath}`);
