import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const HOST = '192.168.68.58';
const BASE = 'https://console.ubuntu-nexus.localdomain';
const PW = fs
  .readFileSync(process.env.SECRETS, 'utf8')
  .split('\n')
  .find((l) => l.startsWith('BOOTSTRAP_ADMIN_PASSWORD='))
  .split('=')
  .slice(1)
  .join('=');
const sh = (cmd) =>
  execFileSync(
    'ssh',
    [
      '-i',
      process.env.KEY,
      '-o',
      'StrictHostKeyChecking=no',
      `aiuser@${HOST}`,
      `echo '${process.env.VMPW}' | sudo -S sh -c ${JSON.stringify(cmd)} 2>/dev/null`,
    ],
    { encoding: 'utf8' },
  );

const cert = sh('cat /tmp/newcert/new.pem');
const key = sh('cat /tmp/newcert/new.key');

const b = await chromium.launch({
  args: ['--host-resolver-rules=MAP console.ubuntu-nexus.localdomain 192.168.68.58'],
});
// ignoreHTTPSErrors mirrors an operator who has accepted the interstitial.
const page = await (
  await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 1200 } })
).newPage();

await page.goto(`${BASE}/login`);
await page.getByLabel(/email|username/i).fill('admin@example.com');
await page.getByLabel(/password/i).fill(PW);
await page.getByRole('button', { name: /sign in|log in/i }).click();
await page.waitForTimeout(3000);
await page.goto(`${BASE}/settings/general`);
await page.getByText('Install a new certificate').waitFor({ timeout: 20000 });
console.log('form offered:', true);

await page.locator('#tls-cert').fill(cert);
await page.locator('#tls-key').fill(key);
await page.screenshot({ path: process.env.SHOT1, fullPage: true });

await page.getByRole('button', { name: /Install certificate/i }).click();

// Watch the state machine.
const seen = new Set();
const started = Date.now();
let final = null;
while (Date.now() - started < 150000) {
  const text = await page
    .locator('main')
    .innerText()
    .catch(() => '');
  for (const marker of [
    'Confirming the new certificate',
    'Re-establishing secure connection',
    'Certificate installed and confirmed',
    'Certificate not installed',
    'console may be unreachable',
  ]) {
    if (text.includes(marker) && !seen.has(marker)) {
      seen.add(marker);
      console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${marker}`);
      if (marker.startsWith('Certificate installed') || marker.startsWith('Certificate not'))
        final = marker;
    }
  }
  if (final) break;
  await new Promise((r) => setTimeout(r, 500));
}
await page.screenshot({ path: process.env.SHOT2, fullPage: true });
console.log('final:', final ?? '(timed out watching)');
await b.close();
