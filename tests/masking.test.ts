import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.js';
import { maskRequest, maskResponse, maskUrl } from '../src/masked.js';

// Built at run time so the repository holds no key-shaped literal.
const key = () => 'sk_live_' + 'Ab3xQ9zL7mK2'.repeat(2);

test('the heal payload masks credentials wherever they sit', async t => {
  const r = await rig(); t.after(r.close);
  await r.runtime.fetch(r.provider.url + '/repair?code=abc123&page=2', {
    method: 'POST', headers: { authorization: 'Bearer secret', 'x-api-key': 'k1', cookie: 'session=s1', accept: 'application/json' },
    body: JSON.stringify({ limit: 500, user: { password: 'hunter2' }, note: `key ${key()} here` }),
  });
  const sent = r.captures[0]!.request;
  assert.equal(sent.headers.authorization, 'Bearer REDACTED');
  assert.equal(sent.headers['x-api-key'], 'REDACTED');
  assert.equal(sent.headers.cookie, undefined, 'cookies never travel');
  assert.equal(sent.headers.accept, 'application/json');
  assert.ok(sent.url.endsWith('/repair?code=REDACTED&page=2'), sent.url);
  assert.deepEqual(sent.body, { limit: 500, user: { password: 'REDACTED' }, note: 'key REDACTED here' });
});

test('a response that echoes a key is masked before it travels', () => {
  assert.equal(maskResponse(`Bad key: ${key()}.`), 'Bad key: REDACTED.');
  assert.deepEqual(maskResponse({ error: { message: `Bad key: ${key()}.` } }), { error: { message: 'Bad key: REDACTED.' } });
});

test('a URL for messages is masked and loses its userinfo', () => {
  assert.equal(maskUrl('https://u:p@a.test/x?token=abc'), 'https://a.test/x?token=REDACTED');
  assert.equal(maskUrl('https://u:p@ss@a.test/x'), 'https://a.test/x');
});

test('a tracked call masks secrets in its path and drops the query', async t => {
  const r = await rig(); t.after(r.close);
  r.runtime.track('POST', () => 'https://hooks.slack.com/services/T0ABC/B0DEF/abcdefghijkl?x=1', 200, Date.now(), 12);
  await r.runtime.tracker.flush();
  assert.equal(r.tracked[0]!.url, 'https://hooks.slack.com/services/T0ABC/B0DEF/REDACTED');
});

test('the retry restores a nested masked value the heal left as sent', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { body: { user: { password: 'REDACTED' }, limit: 100 } };
  await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', body: JSON.stringify({ user: { password: 'hunter2' }, limit: 500 }) });
  assert.deepEqual(r.requests[1]!.body, { user: { password: 'hunter2' }, limit: 100 });
});

test('the retry restores a partly masked string', async t => {
  const r = await rig(); t.after(r.close);
  const note = `key ${key()} here`;
  r.config.result.healedRequest = { body: { note: 'key REDACTED here', limit: 100 } };
  await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', body: JSON.stringify({ note, limit: 500 }) });
  assert.deepEqual(r.requests[1]!.body, { note, limit: 100 });
});

test('the retry restores a masked query value and re-attaches one the heal left out', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { url: r.provider.url + '/repair?limit=100' };
  await r.runtime.fetch(r.provider.url + '/repair?code=abc123&limit=500', { method: 'POST', body: JSON.stringify({ limit: 500 }) });
  assert.ok(r.requests[1]!.path.endsWith('/repair?limit=100&code=abc123'), r.requests[1]!.path);
});

test('the retry never sends a header the heal left masked', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { headers: { authorization: 'Bearer REDACTED', 'x-limit': '100' } };
  await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', headers: { authorization: 'Bearer secret' }, body: JSON.stringify({ limit: 500 }) });
  assert.equal(r.requests[1]!.headers.authorization, 'Bearer secret');
  assert.equal(r.requests[1]!.headers['x-limit'], '100');
});

test('the retry is refused when the heal changed a masked header', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { headers: { authorization: 'Token REDACTED' } };
  await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', headers: { authorization: 'Bearer secret' }, body: JSON.stringify({ limit: 500 }) });
  assert.equal(r.requests.length, 1, 'no retry');
});

test('the retry is refused when a mask would reach the API', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { body: { limit: 100, extra: 'REDACTED' } };
  await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', body: JSON.stringify({ limit: 500 }) });
  assert.equal(r.requests.length, 1, 'no retry');
});

test('an original mentioning the mask does not let a new mask through', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { body: { note: 'REDACTED', apiKey: 'REDACTED' } };
  await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', body: JSON.stringify({ note: 'REDACTED', api_key: 'SECRET', limit: 500 }) });
  assert.equal(r.requests.length, 1, 'no retry');
});

test('a heal that drops a list item never moves a secret to another item', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { body: { items: [{ id: 2, api_key: 'REDACTED' }] } };
  await r.runtime.fetch(r.provider.url + '/repair', { method: 'POST', body: JSON.stringify({ items: [{ id: 1, api_key: 'KEY_ONE' }, { id: 2, api_key: 'KEY_TWO' }], limit: 500 }) });
  assert.ok(r.requests.length === 1 || !JSON.stringify(r.requests[1]!.body).includes('KEY_ONE'));
});

test('a query value holding the mask is never sent', async t => {
  const r = await rig(); t.after(r.close);
  r.config.result.healedRequest = { url: r.provider.url + '/repair?key=xREDACTEDx' };
  await r.runtime.fetch(r.provider.url + '/repair?key=abc', { method: 'POST', body: JSON.stringify({ limit: 500 }) });
  assert.equal(r.requests.length, 1, 'no retry');
});

test('maskRequest reports every address it masked', () => {
  const sent = maskRequest('POST', 'https://a.test/x?token=t1', new Headers({ Authorization: 'Bearer b' }), { a: { secret: 's' } });
  assert.deepEqual(sent.masks, [{ in: 'header', at: 'authorization' }, { in: 'query', at: 'token' }, { in: 'body', at: '/a/secret' }]);
});
