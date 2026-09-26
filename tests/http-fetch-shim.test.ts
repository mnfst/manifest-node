import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { installHttp } from '../src/http.js';
import { Runtime } from '../src/runtime.js';
import type { Fetch } from '../src/types.js';
import { rig, waitFor } from './helpers.js';

// A fetch polyfill built on node:http, the way some runtimes and test tools ship one.
const shim: Fetch = async (input, init) => {
  const request = new Request(input, init);
  const body = Buffer.from(await request.arrayBuffer());
  return new Promise<Response>((resolve, reject) => {
    const outgoing = http.request(request.url, { method: request.method, headers: Object.fromEntries(request.headers) }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks),
        { status: response.statusCode, headers: { 'content-type': String(response.headers['content-type'] ?? '') } })));
      response.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
};

function call(url: string, method: string, body?: string) {
  return new Promise<number | undefined>((resolve, reject) => {
    const request = http.request(url, { method }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode)); response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('the SDK never tracks its own calls when fetch runs on node:http', async t => {
  const r = await rig();
  t.after(r.close);
  const runtime = new Runtime({ key: 'project-key', url: r.api.url + '/' }, shim);
  installHttp(runtime);

  assert.equal(await call(r.provider.url + '/ok', 'POST', '{}'), 200);
  assert.equal(await call(r.provider.url + '/repair', 'POST', JSON.stringify({ limit: 500 })), 200);
  await waitFor(() => runtime.api.pending.size === 0);
  await runtime.tracker.flush(1000);
  await runtime.tracker.flush(1000);

  assert.equal(r.captures.length, 1);
  // One tracked call, the app's own: no batch, heal, report or replay of the SDK's.
  assert.deepEqual(r.tracked.map(c => new URL(c.url).pathname), ['/ok']);
  assert.equal(runtime.tracker.size(), 0);
});
