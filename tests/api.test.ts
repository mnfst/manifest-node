import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HealApi } from '../src/api.js';
import { ATTEMPT, server, reply, waitFor } from './helpers.js';
import type { Capture } from '../src/types.js';
const capture: Capture = { traceId: 'test', request: { method: 'POST', url: 'https://example.com', headers: {}, body: {} }, response: { statusCode: 400, body: 'bad', truncated: false }, responseTimeMs: 1 };

test('heal calls have a wall-clock deadline', async t => {
  const service = await server(() => {}); t.after(service.close);
  const api = new HealApi(fetch, 'key', service.url + '/', 30);
  const started = performance.now();
  assert.equal(await api.heal(capture, new AbortController().signal), null);
  assert.ok(performance.now() - started < 1000);
});

test('rejects oversized heal responses', async t => {
  const service = await server((_req, res) => reply(res, 200, { status: 'patched', extra: 'x'.repeat(1_100_000) }));
  t.after(service.close);
  const api = new HealApi(fetch, 'key', service.url + '/');
  assert.equal(await api.heal(capture, new AbortController().signal), null);
});

test('outcome failures emit warnings', async t => {
  const warnings: string[] = [];
  t.mock.method(process, 'emitWarning', (message: string) => { warnings.push(message); });
  const service = await server((_req, res) => reply(res, 400, {})); t.after(service.close);
  const api = new HealApi(fetch, 'key', service.url + '/');
  api.report(ATTEMPT, { response: { statusCode: 200 } });
  await waitFor(() => warnings.length === 1);
  assert.equal(warnings.length, 1);
});

test('outcome concurrency is bounded', async t => {
  let dropped = 0;
  t.mock.method(process, 'emitWarning', (message: string) => { if (message.includes('capacity')) dropped++; });
  const service = await server(() => {}); t.after(service.close);
  const api = new HealApi(fetch, 'key', service.url + '/', 1000, 100);
  for (let i = 0; i < 70; i++) api.report(ATTEMPT, { response: { statusCode: 200 } });
  assert.equal(dropped, 6);
  assert.ok(api.pending.size <= 64);
  await waitFor(() => api.pending.size === 0, 5000);
});
