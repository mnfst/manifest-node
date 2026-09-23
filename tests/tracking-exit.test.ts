import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { rig } from './helpers.js';

const script = fileURLToPath(new URL('./fixtures/exit-flush.ts', import.meta.url));

async function runScript(env: Record<string, string>): Promise<{ code: number; ms: number }> {
  const started = performance.now();
  const child = spawn(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, ...env }, stdio: 'ignore' });
  const [code] = await once(child, 'exit');
  return { code: code as number, ms: performance.now() - started };
}

test('a script that ends sends its tracked calls on the way out, never its own sends', async t => {
  const r = await rig(); t.after(r.close);
  const { code } = await runScript({ MANIFEST_URL: r.api.url, PROVIDER_URL: r.provider.url, WAIT_MS: '5500' });
  assert.equal(code, 0);
  // Two calls: one sent by the interval, one at exit. A tracked send would be a third.
  assert.deepEqual(r.tracked.map(c => c.url), [r.provider.url + '/ok', r.provider.url + '/ok']);
});

test('a script never hangs on its way out when Manifest does not answer', async t => {
  const r = await rig(); t.after(r.close);
  r.config.requestsDelayMs = 60_000;
  const { code, ms } = await runScript({ MANIFEST_URL: r.api.url, PROVIDER_URL: r.provider.url });
  assert.equal(code, 0);
  assert.ok(ms < 6000, `exit took ${ms.toFixed(0)} ms`);
});
