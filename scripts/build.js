#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAndValidateDicts } from './validate-dicts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CORE_DIR = path.join(ROOT, 'src', 'core');
const DIST_DIR = path.join(ROOT, 'dist');

const CORE_MODULES = [
  'matcher.js',
  'dynamic.js',
  'walker.js',
  'observer.js',
  'collector.js',
  'ui.js',
  'bootstrap.js',
];

function stripModuleSyntax(code) {
  return code
    .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '')
    .replace(/^\s*export\s*\{[\s\S]*?\};?\s*$/gm, '');
}

export function buildAll() {
  const { bundle: dictBundle, stats, warnings, errors } = loadAndValidateDicts();
  if (errors.length > 0) {
    for (const err of errors) console.error(`ERROR: ${err}`);
    throw new Error(`Dictionary validation failed with ${errors.length} error(s).`);
  }
  for (const w of warnings) console.warn(`WARN: ${w}`);

  const parts = CORE_MODULES.map((filename) => {
    const filePath = path.join(CORE_DIR, filename);
    const raw = fs.readFileSync(filePath, 'utf8');
    return `  // --- ${filename} ---\n${stripModuleSyntax(raw)}`;
  });

  const injectorCode = [
    '// Built by antigravity-zh-lite (zero-dependency IIFE bundle)',
    '(function (globalObj) {',
    '  "use strict";',
    `  const INITIAL_DICT = ${JSON.stringify(dictBundle)};`,
    '',
    ...parts,
    '',
    '  bootAntigravityZh(globalObj, INITIAL_DICT);',
    '})(typeof window !== "undefined" ? window : globalThis);',
    '',
  ].join('\n');

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const injectorPath = path.join(DIST_DIR, 'injector.js');
  const dictPath = path.join(DIST_DIR, 'dict.json');
  fs.writeFileSync(injectorPath, injectorCode, 'utf8');
  fs.writeFileSync(dictPath, JSON.stringify(dictBundle, null, 2), 'utf8');

  const sizeKB = (Buffer.byteLength(injectorCode, 'utf8') / 1024).toFixed(1);
  return { injectorPath, dictPath, sizeKB, stats };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const res = buildAll();
  console.log(
    `Build succeeded: dist/injector.js (${res.sizeKB} KB) | ` +
      `${res.stats.exactCount} exact, ${res.stats.scopedCount} scoped, ${res.stats.patternCount} patterns`
  );
}
