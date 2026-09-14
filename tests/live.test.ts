import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { manifest } from '../src/index.js';
import { server, jsonBody, reply, error, waitFor } from './helpers.js';

test('real app: successful repair, failed retry and transport error evidence', { skip: !process.env.MNFST_TEST_APP_URL }, async t => {
  const base = process.env.MNFST_TEST_APP_URL!;
  const original = fetch;
  const signup = await original(base + '/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ name: 'Node SDK test', email: `node-${randomUUID()}@example.test`, password: 'LocalNodeConformance-2026!' }) });
  assert.equal(signup.status, 200);
  const cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const customer = async (path: string, body: unknown) => {
    const response = await original(base + path, { method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 201); return response.json();
  };
  const project = await customer('/api/customer/projects', { name: 'Node SDK conformance' });
  const key = await customer(`/api/customer/projects/${project.id}/keys`, {});
  const outcomes: { code: number; body: any }[] = [];
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/v1/heal-attempts/')) outcomes.push({ code: response.status, body: await response.clone().json() });
    return response;
  };
  t.after(() => { globalThis.fetch = original; });
  const provider = await server(async (req, res) => {
    const body = await jsonBody(req);
    if (body.limit > 100 || req.url!.endsWith('/same')) reply(res, 400, error);
    else if (req.url!.endsWith('/transport')) res.destroy();
    else reply(res, 200, body);
  });
  t.after(provider.close);
  manifest({ key: key.key, url: base });
  const prefix = provider.url + '/node' + randomUUID().replaceAll('-', '');
  const repaired = await fetch(prefix + '/success', { method: 'POST', body: '{"limit":500}' });
  assert.equal(repaired.status, 200); assert.deepEqual(await repaired.json(), { limit: 100 });
  for (const path of ['/same', '/transport']) {
    const response = await fetch(prefix + path, { method: 'POST', body: '{"limit":500}' });
    assert.equal(response.status, 400); await response.body?.cancel();
  }
  await waitFor(() => outcomes.length === 3, 10_000);
  assert.equal(outcomes.length, 3); assert.ok(outcomes.every(item => item.code === 200));
  assert.deepEqual(outcomes.map(item => item.body.status).sort(), ['failed', 'inconclusive', 'succeeded']);
});
