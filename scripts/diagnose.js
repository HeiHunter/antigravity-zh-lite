#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CdpClient, isAntigravityUiTarget, listCdpTargets } from '../src/cdp/client.js';

try {
  const psOut = execFileSync('ps', ['-axo', 'pid=,comm=,args='], { encoding: 'utf8' });
  const matches = psOut
    .split('\n')
    .filter((l) => /antigravity/i.test(l) && !/ag-zh|diagnose|Helper/i.test(l));
  console.log('Antigravity main processes:\n' + matches.join('\n'));
} catch (err) {
  console.log('ps failed:', err.message);
}

const port = Number(process.argv[2] || 9229);
const targets = (await listCdpTargets(port)).filter(isAntigravityUiTarget);
const source = fs.readFileSync(new URL('../dist/injector.js', import.meta.url), 'utf8');

for (const t of targets) {
  const client = new CdpClient(t.webSocketDebuggerUrl);
  await client.connect();
  const evalRes = await client.send('Runtime.evaluate', {
    expression: source,
    returnByValue: false,
  });
  console.log('Inject eval result:', JSON.stringify(evalRes));
  const check = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      hasApi: Boolean(window.__AG_ZH__),
      state: window.__AG_ZH__ ? window.__AG_ZH__.getState() : null,
      hasHost: Boolean(document.getElementById('ag-zh-host'))
    })`,
    returnByValue: true,
  });
  console.log('Post-inject state:', check?.result?.value || check);
  client.close();
}
