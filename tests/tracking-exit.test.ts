import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { rig } from './helpers.js';

test('a script that ends sends its tracked calls on the way out, without hanging', async t => {
  const r = await rig(); t.after(r.close);
  const script = fileURLToPath(new URL('./fixtures/exit-flush.ts', import.meta.url));
  const started = performance.now();
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    env: { ...process.env, MANIFEST_URL: r.api.url, PROVIDER_URL: r.provider.url },
    stdio: 'ignore',
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.ok(performance.now() - started < 10_000);
  assert.equal(r.tracked.length, 1);
  assert.equal(r.tracked[0]!.url, r.provider.url + '/ok');
});
