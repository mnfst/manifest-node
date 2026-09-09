import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import axios from 'axios';
import { flush, manifest } from '../src/index.js';
import { rig } from './helpers.js';

test('default Axios and node:http requests are healed', async t => {
  const r = await rig();
  t.after(async () => { await flush(); await r.close(); });
  manifest({ key: 'project-key', url: r.api.url });

  const successful = await axios.post(r.provider.url + '/ok', { limit: 50 }, { proxy: false });
  assert.equal(successful.status, 200);
  assert.equal(r.captures.length, 0);

  r.config.result = { status: 'no_patch' };
  await assert.rejects(axios.post(r.provider.url + '/repair', { limit: 500 }, { proxy: false }), error =>
    axios.isAxiosError(error) && error.response?.status === 400 && error.response.data.error.code === 'invalid_value');
  assert.equal(r.captures.length, 1);

  r.config.result = { status: 'unverified', healAttemptId: '33333333-3333-4333-8333-333333333333',
    healedRequest: { body: { limit: 100 } } };
  const repaired = await axios.post(r.provider.url + '/repair', { limit: 500 }, { proxy: false });
  assert.equal(repaired.status, 200);
  assert.deepEqual(repaired.data, { received: { limit: 100 } });
  assert.equal(r.captures.length, 2);
  assert.deepEqual(r.captures[1]!.request.body, { limit: 500 });

  const compressed = await axios.post(r.provider.url + '/gzip', { limit: 500 }, { proxy: false });
  assert.deepEqual(compressed.data, { received: { limit: 100 } });

  const direct = await new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    const request = http.request(r.provider.url + '/repair', { method: 'POST' }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString()) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(JSON.stringify({ limit: 500 }));
  });
  assert.deepEqual(direct, { status: 200, body: { received: { limit: 100 } } });

  assert.equal(r.captures.length, 4);
  assert.deepEqual(r.requests.map(request => request.body),
    [{ limit: 50 }, { limit: 500 }, { limit: 500 }, { limit: 100 },
      { limit: 500 }, { limit: 100 }, { limit: 500 }, { limit: 100 }]);
});
