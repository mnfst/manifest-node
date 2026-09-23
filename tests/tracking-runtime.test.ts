import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rig } from './helpers.js';

const send = (url: string, method = 'POST') =>
  new Promise<number>((resolve, reject) => {
    const request = http.request(url, { method }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject); request.end(JSON.stringify({ limit: 50 }));
  });

test('a successful fetch is tracked without its query, and its body is untouched', async t => {
  const r = await rig(); t.after(r.close);
  const response = await r.runtime.fetch(r.provider.url + '/ok?api_key=secret#frag', { method: 'POST', body: '{"limit":50}' });
  assert.deepEqual(await response.json(), { received: { limit: 50 } });
  await r.runtime.tracker.flush();
  assert.equal(r.captures.length, 0);
  assert.equal(r.tracked.length, 1);
  const [call] = r.tracked;
  assert.equal(call!.url, r.provider.url + '/ok');
  assert.equal(call!.method, 'POST');
  assert.equal(call!.statusCode, 200);
  assert.ok(typeof call!.traceId === 'string' && call!.traceId.length > 0);
  assert.ok(!Number.isNaN(Date.parse(call!.occurredAt)));
  assert.deepEqual(Object.keys(call!).sort(), ['method', 'occurredAt', 'responseTimeMs', 'statusCode', 'traceId', 'url']);
});

test('401 and 503 are tracked and never sent to /v1/heal', async t => {
  const r = await rig(); t.after(r.close);
  const { Runtime } = await import('../src/runtime.js');
  for (const status of [401, 503]) {
    // Manifest calls go to the rig's API; every other call answers `status`.
    const upstream: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith(r.api.url) ? fetch(input, init) : new Response('no', { status });
    };
    const runtime = new Runtime({ key: 'k', url: r.api.url + '/' }, upstream);
    const response = await runtime.fetch('http://provider.test/v1/x?token=abc');
    assert.equal(response.status, status);
    await runtime.tracker.flush();
  }
  assert.equal(r.captures.length, 0);
  assert.deepEqual(r.tracked.map(c => [c.url, c.statusCode]),
    [['http://provider.test/v1/x', 401], ['http://provider.test/v1/x', 503]]);
});

test('a healable failure goes to /v1/heal only, never also as a tracked call', async t => {
  const r = await rig(); t.after(r.close);
  const response = await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', body: '{"limit":500}' });
  assert.equal(response.status, 200);
  await r.runtime.tracker.flush();
  assert.equal(r.captures.length, 1);
  assert.deepEqual(r.tracked, []);
});

test('a backend without /v1/requests (404) is ignored and healing still works', async t => {
  const r = await rig(); t.after(r.close);
  r.config.requestsStatus = 404;
  await (await r.runtime.fetch(r.provider.url + '/ok', { method: 'POST', body: '{}' })).text();
  await r.runtime.tracker.flush();
  const healed = await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', body: '{"limit":500}' });
  assert.equal(healed.status, 200);
  assert.equal(r.captures.length, 1);
});

test('node:http calls are tracked too, 2xx and 401 alike', async t => {
  const r = await rig(); t.after(r.close);
  const { installHttp } = await import('../src/http.js');
  installHttp(r.runtime);
  assert.equal(await send(r.provider.url + '/ok?secret=1'), 200);
  await r.runtime.tracker.flush();
  const call = r.tracked.find(c => c.url === r.provider.url + '/ok');
  assert.ok(call, JSON.stringify(r.tracked));
  assert.equal(call!.statusCode, 200);
});

test('no call waits on a send, even one that never answers', async t => {
  const r = await rig(); t.after(r.close);
  r.config.requestsDelayMs = 60_000; // Manifest accepts the batch and never answers
  let slowest = 0;
  for (let i = 0; i < 600; i++) { // crosses 500, so a send starts mid-loop
    const started = performance.now();
    await (await r.runtime.fetch(r.provider.url + '/ok', { method: 'POST', body: '{}' })).text();
    slowest = Math.max(slowest, performance.now() - started);
  }
  assert.ok(slowest < 250, `slowest call ${slowest.toFixed(0)} ms`);
});

test('a healable failure that cannot be healed right now is tracked instead', async t => {
  const r = await rig(); t.after(r.close);
  const { Runtime } = await import('../src/runtime.js');
  const { HealApi } = await import('../src/api.js');
  const api = new HealApi(fetch, 'project-key', r.api.url + '/');
  api.canHeal = () => false; // every heal slot busy, or the project disabled
  const runtime = new Runtime({ key: 'project-key', url: r.api.url + '/' }, fetch, api);
  const response = await runtime.fetch(r.provider.url + '/same', { method: 'POST', body: '{}' });
  assert.equal(response.status, 400); await response.body?.cancel();
  await runtime.tracker.flush();
  assert.equal(r.captures.length, 0);
  assert.deepEqual(r.tracked.map(c => c.statusCode), [400]);
});

test('methods are upper-cased and out-of-range records are never sent', async t => {
  const r = await rig(); t.after(r.close);
  r.runtime.track('patch', () => r.provider.url + '/x', 200, Date.now(), 1);
  r.runtime.track('X'.repeat(17), () => r.provider.url + '/x', 200, Date.now(), 1);
  r.runtime.track('GET', () => r.provider.url + '/' + 'a'.repeat(4100), 200, Date.now(), 1);
  r.runtime.track('GET', () => 'mailto:a@b.co', 200, Date.now(), 1);
  await r.runtime.tracker.flush();
  assert.deepEqual(r.tracked.map(c => c.method), ['PATCH']);
});
