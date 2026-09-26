import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { installHttp } from '../src/http.js';
import { rig } from './helpers.js';

const denied = { allow: null, deny: [{ host: '127.0.0.1', path: '/repair' }] };

test('fetch: a denied route is neither healed nor tracked, and its response is untouched', async t => {
  const r = await rig({ filter: denied });
  t.after(r.close);
  const failed = await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', body: JSON.stringify({ limit: 500 }) });
  const ok = await r.runtime.fetch(r.provider.url + '/ok');
  await r.runtime.tracker.flush(1000);
  assert.equal(failed.status, 400);
  assert.equal((await failed.json()).error.code, 'invalid_value');
  assert.equal(ok.status, 200);
  assert.equal(r.captures.length, 0);
  // The route is denied, not the host: the other call on it is tracked as usual.
  assert.deepEqual(r.tracked.map(c => new URL(c.url).pathname), ['/ok']);
  assert.equal(r.requests.length, 2);
});

test('node:http: a host off the allowlist is neither healed nor tracked', async t => {
  const r = await rig({ filter: { allow: [{ host: 'example.com', path: null }], deny: [] } });
  t.after(r.close);
  installHttp(r.runtime);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.request(r.provider.url + '/repair', { method: 'POST' }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode)); response.on('error', reject);
    });
    request.on('error', reject);
    request.end(JSON.stringify({ limit: 500 }));
  });
  await r.runtime.tracker.flush(1000);
  assert.equal(status, 400);
  assert.equal(r.captures.length, 0);
  assert.equal(r.tracked.length, 0);
});
