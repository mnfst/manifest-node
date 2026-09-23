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

test('the SDK never tracks its own calls to Manifest', async t => {
  const r = await rig(); t.after(r.close);
  await (await r.runtime.fetch(r.provider.url + '/ok', { method: 'POST', body: '{}' })).text();
  await r.runtime.tracker.flush();
  await r.runtime.tracker.flush();
  assert.equal(r.tracked.length, 1);
  assert.ok(r.tracked.every(c => !c.url.startsWith(r.api.url)));
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

test('tracking adds no latency even when Manifest answers slowly', async t => {
  const r = await rig(); t.after(r.close);
  r.config.requestsDelayMs = 1000;
  const run = async (doFetch: typeof fetch) => {
    const started = performance.now();
    for (let i = 0; i < 600; i++) await (await doFetch(r.provider.url + '/ok', { method: 'POST', body: '{}' })).text();
    return performance.now() - started;
  };
  const baseline = await run(fetch);
  const tracked = await run(r.runtime.fetch);
  // 600 calls cross the 500 threshold, so a send starts mid-run and takes 1 s:
  // any await on it would add at least that.
  assert.ok(tracked < baseline * 1.5 + 500, `baseline ${baseline.toFixed(0)} ms, tracked ${tracked.toFixed(0)} ms`);
  await r.runtime.tracker.flush();
  assert.equal(r.tracked.length, 600);
});
