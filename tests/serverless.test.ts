import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { isServerless } from '../src/serverless.js';
import { rig } from './helpers.js';

const script = fileURLToPath(new URL('./fixtures/serverless.ts', import.meta.url));

async function invoke(env: Record<string, string>): Promise<number> {
  const clean = { ...process.env };
  for (const name of ['VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'K_SERVICE']) delete clean[name];
  const child = spawn(process.execPath, ['--import', 'tsx', script], { env: { ...clean, ...env }, stdio: 'ignore' });
  const [code] = await once(child, 'exit');
  return code as number;
}

test('on Vercel, a tracked call is delivered before the function freezes', async t => {
  const r = await rig(); t.after(r.close);
  const code = await invoke({ VERCEL: '1', MANIFEST_URL: r.api.url, PROVIDER_URL: r.provider.url });
  assert.equal(code, 0);
  assert.deepEqual(r.tracked.map(c => c.url), [r.provider.url + '/ok']);
});

test('under the Next.js request context, the call is delivered the same way', async t => {
  const r = await rig(); t.after(r.close);
  await invoke({ AWS_LAMBDA_FUNCTION_NAME: 'fn', CONTEXT_SYMBOL: '@next/request-context',
    MANIFEST_URL: r.api.url, PROVIDER_URL: r.provider.url });
  assert.deepEqual(r.tracked.map(c => c.url), [r.provider.url + '/ok']);
});

test('on Vercel, a heal outcome report is delivered before the function freezes', async t => {
  const r = await rig(); t.after(r.close);
  r.config.reportDelayMs = 300; // still on the wire when the handler returns
  await invoke({ VERCEL: '1', MANIFEST_URL: r.api.url, PROVIDER_URL: r.provider.url,
    CALL_PATH: '/repair', CALL_BODY: '{"limit":500}' });
  assert.equal(r.captures.length, 1);
  assert.equal(r.outcomes.length, 1);
});

test('isServerless reads the platform variables and nothing else', () => {
  assert.equal(isServerless({}), false);
  assert.equal(isServerless({ VERCEL: '1' }), true);
  assert.equal(isServerless({ AWS_LAMBDA_FUNCTION_NAME: 'fn' }), true);
  assert.equal(isServerless({ K_SERVICE: 'svc' }), true);
  assert.equal(isServerless({ VERCEL: '' }), false);
});
