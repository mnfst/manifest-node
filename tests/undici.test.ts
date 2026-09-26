import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetch as undiciFetch, request as undiciRequest } from 'undici';
import { installUndici } from '../src/undici.js';
import { rig } from './helpers.js';

// Libraries such as @vercel/blob import fetch from the undici package, which
// never goes through globalThis.fetch or node:http.
test('a call through the undici package is tracked', async t => {
  const r = await rig(); t.after(r.close); t.after(installUndici(r.runtime));
  const response = await undiciFetch(r.provider.url + '/ok?token=secret', { method: 'POST', body: '{"limit":50}' });
  assert.deepEqual(await response.json(), { received: { limit: 50 } });
  await r.runtime.tracker.flush();
  assert.deepEqual(r.tracked.map(c => [c.method, c.url, c.statusCode]), [['POST', r.provider.url + '/ok', 200]]);
});

test('undici request() calls are tracked too', async t => {
  const r = await rig(); t.after(r.close); t.after(installUndici(r.runtime));
  const { statusCode, body } = await undiciRequest(r.provider.url + '/ok', { method: 'POST', body: '{}' });
  await body.text();
  await r.runtime.tracker.flush();
  assert.deepEqual(r.tracked.map(c => [c.url, c.statusCode]), [[r.provider.url + '/ok', statusCode]]);
});

test('a fetch captured before install is tracked through the built-in undici', async t => {
  const r = await rig(); t.after(r.close); t.after(installUndici(r.runtime));
  const captured = globalThis.fetch; // Node's own fetch, never wrapped by the runtime here
  await (await captured(r.provider.url + '/ok', { method: 'POST', body: '{}' })).text();
  await r.runtime.tracker.flush();
  assert.deepEqual(r.tracked.map(c => c.url), [r.provider.url + '/ok']);
});

test('a call through the runtime fetch is tracked once, not also by undici', async t => {
  const r = await rig(); t.after(r.close); t.after(installUndici(r.runtime));
  await (await r.runtime.fetch(r.provider.url + '/ok', { method: 'POST', body: '{}' })).text();
  await r.runtime.tracker.flush();
  assert.equal(r.tracked.length, 1);
});

test('a healed call is neither tracked by undici nor its retry', async t => {
  const r = await rig(); t.after(r.close); t.after(installUndici(r.runtime));
  const response = await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', body: '{"limit":500}' });
  assert.equal(response.status, 200);
  await r.runtime.tracker.flush();
  assert.equal(r.captures.length, 1);
  assert.deepEqual(r.tracked, []);
});

// A regression loops forever (each batch tracked, sent, tracked again), so fail fast.
test("Manifest's own calls are never tracked", { timeout: 5000 }, async t => {
  const r = await rig(); t.after(r.close); t.after(installUndici(r.runtime));
  await (await undiciFetch(r.provider.url + '/ok', { method: 'POST', body: '{}' })).text();
  await r.runtime.tracker.flush(); // this send goes through the built-in undici
  r.runtime.api.hello('node-test');
  await new Promise(resolve => setTimeout(resolve, 100));
  await r.runtime.tracker.flush();
  assert.deepEqual(r.tracked.map(c => c.url), [r.provider.url + '/ok']);
});

test('uninstalling stops tracking', async t => {
  const r = await rig(); t.after(r.close);
  installUndici(r.runtime)();
  await (await undiciFetch(r.provider.url + '/ok', { method: 'POST', body: '{}' })).text();
  await r.runtime.tracker.flush();
  assert.deepEqual(r.tracked, []);
});

test('the allowlist and denylist apply to undici calls too', async t => {
  const r = await rig({ filter: { allow: null, deny: [{ host: '127.0.0.1', path: '/denied' }] } });
  t.after(r.close); t.after(installUndici(r.runtime));
  for (const path of ['/denied', '/ok']) await (await undiciFetch(r.provider.url + path, { method: 'POST', body: '{}' })).text();
  await r.runtime.tracker.flush();
  assert.deepEqual(r.tracked.map(c => new URL(c.url).pathname), ['/ok']);
});
