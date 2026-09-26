import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import { installHttp } from '../src/http.js';
import { rig } from './helpers.js';

function call(url: string, options: http.RequestOptions, body?: string) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const request = http.request(url, options, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

// One install for the whole file: each installHttp wraps the previous one.
test('node:http heals only a call a fetch replay reaches the same way', async t => {
  const r = await rig();
  t.after(r.close);
  installHttp(r.runtime);
  const body = JSON.stringify({ limit: 500 });

  await t.test('a plain request is healed', async () => {
    assert.equal((await call(r.provider.url + '/repair', { method: 'POST' }, body)).status, 200);
    assert.equal(r.captures.length, 1);
  });

  await t.test('a Host header naming another server is never replayed there', async () => {
    const result = await call(r.provider.url + '/repair', { method: 'POST', headers: { host: 'elsewhere.test' } }, body);
    assert.equal(result.status, 400);
    assert.equal(r.captures.length, 1);
    assert.equal(r.requests.at(-1)!.headers.host, 'elsewhere.test');
  });

  await t.test('a custom agent or connection option is not replayed through fetch', async () => {
    const agent = new (class ProxyAgent extends http.Agent {
      connect() { return undefined; }
    })();
    assert.equal((await call(r.provider.url + '/repair', { method: 'POST', agent }, body)).status, 400);
    const lookup = ((host, options, callback) => dns.lookup(host, options, callback)) as http.RequestOptions['lookup'];
    assert.equal((await call(r.provider.url + '/repair', { method: 'POST', lookup }, body)).status, 400);
    const tls = new http.Agent({ keepAlive: true, rejectUnauthorized: false } as http.AgentOptions);
    assert.equal((await call(r.provider.url + '/repair', { method: 'POST', agent: tls }, body)).status, 400);
    assert.equal(r.captures.length, 1);
    // A standard keep-alive agent carries nothing a replay would lose.
    const keepAlive = new http.Agent({ keepAlive: true });
    assert.equal((await call(r.provider.url + '/repair', { method: 'POST', agent: keepAlive }, body)).status, 200);
    assert.equal(r.captures.length, 2);
    // A keep-alive subclass (agentkeepalive, under the OpenAI and Anthropic SDKs) is healed too.
    const subclass = new (class KeepAliveAgent extends http.Agent {})({ keepAlive: true });
    assert.equal((await call(r.provider.url + '/repair', { method: 'POST', agent: subclass }, body)).status, 200);
    assert.equal(r.captures.length, 3);
    keepAlive.destroy(); tls.destroy(); agent.destroy(); subclass.destroy();
  });

  await t.test('a method fetch refuses gets the original response, not an error', async () => {
    const result = await call(r.provider.url + '/same', { method: 'TRACE' });
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(result.body).error.code, 'invalid_value');
    assert.equal(r.captures.length, 3);
    await r.runtime.tracker.flush(1000);
    assert.ok(r.tracked.some(c => c.method === 'TRACE' && c.statusCode === 400));
  });
});
