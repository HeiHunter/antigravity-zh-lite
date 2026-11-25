#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildAll } from './build.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const INCLUDE_TOP_LEVEL = [
  'package.json',
  'LICENSE',
  'README.md',
  '.gitignore',
  'ag-zh.config.example.json',
  '启动汉化.command',
  '启动汉化.bat',
  'bin',
  'src',
  'scripts',
  'dicts',
  'tests',
];

function shouldIncludeFile(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  const base = path.basename(norm);
  if (base === '.DS_Store') return false;
  if (norm.startsWith('dicts/_')) return false;
  if (norm === 'ag-zh.config.json') return false;
  return true;
}

function copyFiltered(srcRoot, dstRoot, rel = '') {
  const srcPath = path.join(srcRoot, rel);
  const dstPath = path.join(dstRoot, rel);
  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    fs.mkdirSync(dstPath, { recursive: true });
    for (const entry of fs.readdirSync(srcPath)) {
      const childRel = rel ? path.join(rel, entry) : entry;
      if (shouldIncludeFile(childRel)) {
        copyFiltered(srcRoot, dstRoot, childRel);
      }
    }
  } else if (shouldIncludeFile(rel)) {
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.copyFileSync(srcPath, dstPath);
    fs.chmodSync(dstPath, stat.mode);
  }
}

export function collectReleaseFiles(rootDir = ROOT) {
  const files = [];
  function walk(rel) {
    const full = path.join(rootDir, rel);
    if (!fs.existsSync(full)) return;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(full)) {
        const child = path.join(rel, entry);
        if (shouldIncludeFile(child)) walk(child);
      }
    } else if (shouldIncludeFile(rel)) {
      files.push(rel.replace(/\\/g, '/'));
    }
  }
  for (const item of INCLUDE_TOP_LEVEL) walk(item);
  return files.sort();
}

export function packRelease({ rootDir = ROOT, outDir = path.join(ROOT, 'release') } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const bundleName = `${pkg.name}-v${pkg.version}`;

  buildAll();

  const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-zh-release-'));
  const stageDir = path.join(stageParent, bundleName);
  fs.mkdirSync(stageDir, { recursive: true });

  try {
    for (const item of INCLUDE_TOP_LEVEL) {
      if (fs.existsSync(path.join(rootDir, item))) {
        copyFiltered(rootDir, stageDir, item);
      }
    }

    fs.mkdirSync(outDir, { recursive: true });
    const tarName = `${bundleName}.tar.gz`;
    const zipName = `${bundleName}.zip`;
    const tarPath = path.join(outDir, tarName);
    const zipPath = path.join(outDir, zipName);

    let hasTar = false;
    try {
      const stagedTar = path.join(stageParent, tarName);
      execFileSync('tar', ['-czf', tarName, bundleName], { cwd: stageParent, stdio: 'pipe' });
      fs.copyFileSync(stagedTar, tarPath);
      hasTar = true;
    } catch {
      hasTar = false;
    }

    let hasZip = false;
    try {
      if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
      if (process.platform === 'win32') {
        const psSrc = stageDir.replace(/'/g, "''");
        const psDst = zipPath.replace(/'/g, "''");
        execFileSync(
          'powershell',
          ['-NoProfile', '-Command', `Compress-Archive -Path '${psSrc}' -DestinationPath '${psDst}' -Force`],
          { stdio: 'pipe', windowsHide: true }
        );
      } else {
        execFileSync('zip', ['-rq', zipPath, bundleName], { cwd: stageParent, stdio: 'pipe' });
      }
      hasZip = true;
    } catch {
      hasZip = false;
    }

    if (!hasTar && !hasZip) {
      throw new Error('Failed to create both .tar.gz and .zip release archives');
    }

    const files = collectReleaseFiles(rootDir);
    const tarKB = hasTar ? (fs.statSync(tarPath).size / 1024).toFixed(1) : null;
    const zipKB = hasZip ? (fs.statSync(zipPath).size / 1024).toFixed(1) : null;

    return {
      bundleName,
      files,
      tarPath: hasTar ? tarPath : null,
      tarKB,
      zipPath: hasZip ? zipPath : null,
      zipKB,
    };
  } finally {
    fs.rmSync(stageParent, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const res = packRelease();
  console.log(`\n✅ 发布包构建完成（共 ${res.files.length} 个干净文件，已自动排除所有本地缓存与隐私文件）：`);
  if (res.tarPath) {
    console.log(`  • tar.gz : ${res.tarPath} (${res.tarKB} KB)`);
  }
  if (res.zipPath) {
    console.log(`  • zip    : ${res.zipPath} (${res.zipKB} KB)`);
  }
  console.log('');
}
