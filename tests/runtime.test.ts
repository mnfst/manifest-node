import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, waitFor } from './helpers.js';
import { Runtime } from '../src/runtime.js';

test('repairs JSON, masks credentials, preserves withheld fields and reports actual outcome', async t => {
  const r = await rig(); t.after(r.close);
  const response = await r.runtime.fetch(r.provider.url + '/repair?apiKey=hidden', {
    method: 'POST', headers: { authorization: 'Bearer secret', 'idempotency-key': 'same-key' },
    body: JSON.stringify({ limit: 500, apiKey: 'local-secret', obsolete: true }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: { limit: 100, apiKey: 'local-secret' } });
  assert.deepEqual(r.captures[0]!.request.body, { limit: 500, obsolete: true });
  assert.equal(r.captures[0]!.request.headers.authorization, 'REDACTED');
  assert.ok(!r.captures[0]!.request.url.includes('hidden'));
  assert.equal(r.requests[1]!.headers.authorization, 'Bearer secret');
  assert.equal(r.requests[1]!.headers['idempotency-key'], 'same-key');
  await waitFor(() => r.runtime.api.pending.size === 0); assert.deepEqual(r.outcomes, [{ response: { statusCode: 200 } }]);
});

test('repairs fetch form-urlencoded bodies without changing their encoding', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { body: { limit: '100' } };
  const response = await r.runtime.fetch(r.provider.url + '/repair', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: 'limit=500',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(r.captures[0]!.request.body, { limit: '500' });
  assert.deepEqual(r.requests.map(request => request.body), [{ limit: '500' }, { limit: '100' }]);
  assert.equal(r.requests[1]!.headers['content-type'], 'application/x-www-form-urlencoded; charset=UTF-8');
});

test('does not retry malformed or oversized form-urlencoded bodies', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { body: { limit: '100' } };
  for (const body of ['limit=%GG', `limit=${'1'.repeat(262_145)}`]) {
    const response = await r.runtime.fetch(r.provider.url + '/same', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    });
    assert.equal(response.status, 400); await response.body?.cancel();
  }
  assert.equal(r.requests.length, 2);
  assert.deepEqual(r.captures.map(capture => capture.request.body), [null, null]);
});

test('replays nested form fields as bracket keys and skips non-object healed bodies', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { body: { limit: '100', line_items: [{ price: 'price_123' }] } };
  const response = await r.runtime.fetch(r.provider.url + '/repair', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'limit=500&line_items%5B0%5D%5Bprice%5D=price_000',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(r.captures[0]!.request.body, { limit: '500', line_items: [{ price: 'price_000' }] });
  assert.deepEqual(r.requests[1]!.body, { limit: '100', 'line_items[0][price]': 'price_123' });

  r.config.result.healedRequest = { body: 'limit=100' };
  const rejected = await r.runtime.fetch(r.provider.url + '/same', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'limit=500',
  });
  assert.equal(rejected.status, 400); await rejected.body?.cancel();
  assert.equal(r.requests.length, 3);
});

test('supports Request inputs and streamed requests without losing the original body', async t => {
  const r = await rig(); t.after(r.close);
  const input = new Request(r.provider.url + '/repair', { method: 'POST', body: JSON.stringify({ limit: 500 }) });
  const response = await r.runtime.fetch(input);
  assert.equal(response.status, 200);
  assert.equal(input.bodyUsed, true);
  assert.equal(r.requests[0]!.body.limit, 500);
});

test('successful retries stay streamed', async t => {
  const r = await rig(); t.after(r.close);
  const response = await r.runtime.fetch(r.provider.url + '/stream', { method: 'POST', body: '{"limit":500}' });
  assert.equal(response.status, 200); assert.equal(response.bodyUsed, false);
  assert.ok(r.config.finish);
  r.config.finish(); assert.equal(await response.text(), 'firstlast');
});

test('successful original calls never contact Manifest', async t => {
  const r = await rig(); t.after(r.close);
  const response = await r.runtime.fetch(r.provider.url + '/ok', { method: 'POST', body: '{"limit":50}' });
  assert.equal(response.status, 200); assert.equal(r.captures.length, 0);
  await response.body?.cancel();
});

test('failed retries send raw error evidence and do not loop', async t => {
  const r = await rig(); t.after(r.close);
  const response = await r.runtime.fetch(r.provider.url + '/same', { method: 'POST', body: '{"limit":500}' });
  const body = await response.json(); await waitFor(() => r.runtime.api.pending.size === 0);
  assert.equal(response.status, 400); assert.equal(r.requests.length, 2);
  assert.deepEqual(r.outcomes, [{ response: { statusCode: 400, body, truncated: false } }]);
});

test('transport failure returns original error and records inconclusive evidence', async t => {
  const r = await rig(); t.after(r.close);
  const response = await r.runtime.fetch(r.provider.url + '/transport', { method: 'POST', body: '{"limit":500}' });
  assert.equal(response.status, 400); assert.ok((await response.json()).error);
  await waitFor(() => r.runtime.api.pending.size === 0);
  assert.equal('failure' in r.outcomes[0]! && r.outcomes[0].failure.kind, 'transport_error');
});

test('disabled project backs off and no_patch preserves original response metadata', async t => {
  const r = await rig(); t.after(r.close);
  r.config.disabled = true;
  for (let i = 0; i < 2; i++) {
    const response = await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', body: '{"limit":500}' });
    assert.equal(response.status, 400); assert.equal(response.url, r.provider.url + '/repair');
    const cloned = response.clone(); assert.equal(cloned.url, response.url);
    await Promise.all([cloned.text(), response.text()]);
  }
  assert.equal(r.captures.length, 1);
});

test('cross-origin repairs are refused and reported as not_attempted', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { url: 'https://other.example/steal', body: { limit: 100 } };
  const response = await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', body: '{"limit":500}' });
  assert.equal(response.status, 400);   await response.body?.cancel(); await waitFor(() => r.runtime.api.pending.size === 0);
  assert.equal(r.requests.length, 1);
  assert.equal('failure' in r.outcomes[0]! && r.outcomes[0].failure.kind, 'not_attempted');
});

test('abort remains observable to the caller', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  const runtime = new Runtime({ key: 'k', url: 'http://unused/' }, fetch);
  await assert.rejects(runtime.fetch('http://127.0.0.1:1', { signal: controller.signal }), /cancelled/);
});

test('preserves fetch extension options such as dispatcher', async () => {
  const marker = {};
  let actual: unknown;
  const runtime = new Runtime({ key: 'k', url: 'http://unused/' }, async (_input, init) => {
    actual = (init as RequestInit & { dispatcher: unknown }).dispatcher;
    return new Response('ok');
  });
  await runtime.fetch('https://example.com', { dispatcher: marker } as RequestInit);
  assert.equal(actual, marker);
});

test('applies healed headers and same-origin URL without changing caller credentials', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { url: r.provider.url + '/new', body: { limit: 100 }, headers: { 'x-remove': null, 'x-added': 'yes' } };
  const response = await r.runtime.fetch(r.provider.url + '/old', { method: 'POST', headers: { 'x-remove': 'bad' }, body: '{"limit":500}' });
  await response.body?.cancel();
  assert.equal(r.requests[1]!.path, '/new');
  assert.equal(r.requests[1]!.headers['x-remove'], undefined);
  assert.equal(r.requests[1]!.headers['x-added'], 'yes');
});

test('puts the caller\'s own query credentials back on a healed URL', async t => {
  // The SDK masks ?key= on the wire and the server drops credentials from the
  // URL it serves, so the retry must restore the caller's key, while a value the
  // server did heal still wins.
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { url: r.provider.url + '/new?limit=100&session=REDACTED', body: { limit: 100 } };
  const response = await r.runtime.fetch(r.provider.url + '/old?key=AIza-live&limit=500&session=s1', { method: 'POST', body: '{"limit":500}' });
  await response.body?.cancel();
  const retried = new URL(r.requests[1]!.path, r.provider.url).searchParams;
  assert.equal(retried.get('key'), 'AIza-live');
  assert.equal(retried.get('session'), 's1');
  assert.equal(retried.get('limit'), '100');
});

test('never sets a header the server served back under the SDK\'s own mask', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { headers: { 'x-signature': 'REDACTED', 'x-added': 'yes' }, body: { limit: 100 } };
  const response = await r.runtime.fetch(r.provider.url + '/old', { method: 'POST', headers: { 'x-signature': 'sig-1' }, body: '{"limit":500}' });
  await response.body?.cancel();
  assert.equal(r.requests[1]!.headers['x-signature'], 'sig-1');
  assert.equal(r.requests[1]!.headers['x-added'], 'yes');
});

test('does not retry with incomplete capture evidence', async () => {
  let upstreamCalls = 0; let reports = 0;
  const raw: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/v1/heal-attempts/')) { reports++; return new Response('{}'); }
    if (url.includes('/v1/heal')) return Response.json({ status: 'unverified', healAttemptId: '33333333-3333-4333-8333-333333333333', healedRequest: { body: { limit: 100 } } });
    upstreamCalls++;
    return new Response('x'.repeat(100_000), { status: 400 });
  };
  const runtime = new Runtime({ key: 'k', url: 'http://manifest/' }, raw);
  const response = await runtime.fetch('http://provider/repair', { method: 'POST', body: '{"limit":500}' });
  assert.equal((await response.text()).length, 100_000);
  await waitFor(() => runtime.api.pending.size === 0); assert.equal(upstreamCalls, 1); assert.equal(reports, 1);
});

// Forbidden: editing the request cannot fix auth, billing, rate limits or a
// server fault. Everything else in 4xx is a request the server refused.
for (const status of [200, 204, 301, 401, 402, 403, 429, 500, 503, 599]) {
  test(`HTTP ${status} passes through without a heal call`, async () => {
    let calls = 0;
    const response = new Response(status === 204 ? null : 'untouched', { status });
    const runtime = new Runtime({ key: 'k', url: 'http://manifest/' }, async () => { calls++; return response; });
    assert.equal(await runtime.fetch('http://provider'), response); assert.equal(calls, 1);
  });
}

for (const status of [400, 404, 405, 409, 410, 413, 415, 422, 428, 451, 499]) {
  test(`HTTP ${status} is captured as a request-side failure`, async () => {
    let calls = 0;
    const runtime = new Runtime({ key: 'k', url: 'http://manifest/' }, async () => {
      calls++; return new Response('nope', { status });
    });
    const response = await runtime.fetch('http://provider');
    // the original error still reaches the caller; the second call is the heal
    assert.equal(response.status, status); assert.equal(calls, 2);
  });
}

test('no_patch returns the original error bytes and opens no outcome report', async t => {
  const r = await rig(); t.after(r.close); r.config.result = { status: 'no_patch' };
  const response = await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', body: '{"limit":500}' });
  assert.equal(response.status, 400); assert.ok((await response.json()).error);
  await waitFor(() => r.runtime.api.pending.size === 0); assert.equal(r.requests.length, 1); assert.equal(r.outcomes.length, 0);
});

test('a real streaming upload is sent intact and can be healed once fully captured', async t => {
  const r = await rig(); t.after(r.close);
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"limit":'));
    controller.enqueue(new TextEncoder().encode('500}')); controller.close();
  } });
  const response = await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  assert.equal(response.status, 200); await response.body?.cancel();
  assert.deepEqual(r.requests[0]!.body, { limit: 500 });
});

test('failures after redirects are not misattributed to the original request', async () => {
  let calls = 0;
  const response = new Response('redirect target error', { status: 400 });
  Object.defineProperty(response, 'redirected', { value: true });
  const runtime = new Runtime({ key: 'k', url: 'http://manifest/' }, async () => { calls++; return response; });
  assert.equal(await runtime.fetch('http://provider/original'), response); assert.equal(calls, 1);
});

test('caller cancellation during healing rejects rather than returning a stale error', async () => {
  const controller = new AbortController();
  const runtime = new Runtime({ key: 'k', url: 'http://manifest/' }, async input => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/v1/heal')) { controller.abort(new Error('cancel during heal')); throw controller.signal.reason; }
    return new Response('bad', { status: 400 });
  });
  await assert.rejects(runtime.fetch('http://provider', { signal: controller.signal }), /cancel during heal/);
});

test('upstream latency excludes time spent finishing SDK body capture', async t => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  let finish: (() => void) | undefined;
  const stream = new ReadableStream({ start(controller) {
    finish = () => { controller.enqueue(new TextEncoder().encode('{"limit":500}')); controller.close(); };
  } });
  let elapsed = -1;
  const raw: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/v1/heal')) {
      elapsed = JSON.parse(String(init!.body)).responseTimeMs;
      return Response.json({ status: 'no_patch' });
    }
    setTimeout(() => { clock = 200; finish!(); }, 1);
    void (input as Request).body?.cancel().catch(() => {});
    return new Response('bad', { status: 400 });
  };
  const runtime = new Runtime({ key: 'k', url: 'http://manifest/' }, raw);
  const response = await runtime.fetch('http://provider', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  await response.body?.cancel(); assert.equal(elapsed, 0);
});

// A query-only patch comes back with `body: null`. DELETE and OPTIONS carry no
// body of their own here, so the retry goes out bodyless instead of being dropped.
test('retries a bodyless DELETE when the patch carries no body', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { url: r.provider.url + '/items/1?force=true', body: null };
  const response = await r.runtime.fetch(r.provider.url + '/same/items/1', { method: 'DELETE' });
  await response.body?.cancel();
  assert.equal(r.requests.length, 2);
  assert.equal(r.requests[1]!.path, '/items/1?force=true');
  assert.equal(r.requests[1]!.headers['content-length'], undefined);
  assert.equal(r.requests[1]!.body, null);
});
