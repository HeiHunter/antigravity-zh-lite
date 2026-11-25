#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DICTS_DIR = path.join(ROOT, 'dicts');

export function loadAndValidateDicts(dictsDir = DICTS_DIR) {
  const files = fs
    .readdirSync(dictsDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort();

  const exact = {};
  const scoped = [];
  const patterns = [];
  const ignoreSelectors = new Set();
  const seenExact = new Map();
  const warnings = [];
  const errors = [];

  for (const file of files) {
    const fullPath = path.join(dictsDir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (err) {
      errors.push(`[${file}] Invalid JSON: ${err.message}`);
      continue;
    }

    if (data.exact && typeof data.exact === 'object') {
      for (const [k, v] of Object.entries(data.exact)) {
        if (typeof v !== 'string' || !v.trim()) {
          errors.push(`[${file}] Empty or non-string translation for key "${k}"`);
          continue;
        }
        const key = k.trim();
        if (seenExact.has(key) && seenExact.get(key).value !== v) {
          warnings.push(
            `Duplicate exact key "${key}": "${seenExact.get(key).value}" (${seenExact.get(key).file}) overridden by "${v}" (${file})`
          );
        }
        seenExact.set(key, { file, value: v });
        exact[key] = v;
      }
    }

    if (Array.isArray(data.scoped)) {
      for (const entry of data.scoped) {
        if (!entry || typeof entry.selector !== 'string' || typeof entry.exact !== 'object') {
          errors.push(`[${file}] Invalid scoped entry: ${JSON.stringify(entry)}`);
          continue;
        }
        scoped.push({ selector: entry.selector, exact: entry.exact });
      }
    }

    if (Array.isArray(data.patterns)) {
      for (const entry of data.patterns) {
        if (!entry || typeof entry.regex !== 'string' || typeof entry.replace !== 'string') {
          errors.push(`[${file}] Invalid pattern entry: ${JSON.stringify(entry)}`);
          continue;
        }
        try {
          new RegExp(entry.regex, entry.flags || '');
        } catch (err) {
          errors.push(`[${file}] Invalid RegExp "${entry.regex}": ${err.message}`);
          continue;
        }
        patterns.push({
          hint: typeof entry.hint === 'string' ? entry.hint : '',
          regex: entry.regex,
          flags: typeof entry.flags === 'string' ? entry.flags : '',
          replace: entry.replace,
        });
      }
    }

    if (Array.isArray(data.ignoreSelectors)) {
      for (const sel of data.ignoreSelectors) {
        if (typeof sel === 'string' && sel.trim()) {
          ignoreSelectors.add(sel.trim());
        }
      }
    }
  }

  return {
    bundle: {
      exact,
      scoped,
      patterns,
      ignoreSelectors: [...ignoreSelectors],
    },
    stats: {
      files: files.length,
      exactCount: Object.keys(exact).length,
      scopedCount: scoped.reduce((acc, s) => acc + Object.keys(s.exact).length, 0),
      patternCount: patterns.length,
      ignoreSelectorCount: ignoreSelectors.size,
    },
    warnings,
    errors,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = loadAndValidateDicts();
  for (const w of result.warnings) {
    console.warn(`WARN: ${w}`);
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) {
      console.error(`ERROR: ${e}`);
    }
    process.exit(1);
  }
  console.log(
    `Dict validation passed: ${result.stats.files} files | ` +
      `${result.stats.exactCount} exact | ${result.stats.scopedCount} scoped | ` +
      `${result.stats.patternCount} patterns | ${result.stats.ignoreSelectorCount} ignore selectors`
  );
}
