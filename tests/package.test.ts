import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/api.js';
import { jsonBody, reply, server } from './helpers.js';

test('runtime version matches the package version', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(VERSION, packageJson.version);
});

test('the built CLI reports the SDK version', () => {
  const stdout = execFileSync(process.execPath, ['dist/bin.js', '--version'], { encoding: 'utf8' });
  assert.equal(stdout.trim(), VERSION);
});

test('ESM and CommonJS share one installation and expose manifest without compatibility aliases', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import * as esm from './dist/index.js';
    const cjs = createRequire(import.meta.url)('./dist/index.cjs');
    assert.deepEqual(Object.keys(esm).sort(), ['VERSION', 'manifest']);
    assert.equal(cjs.autofix, undefined);
    const original = globalThis.fetch;
    esm.manifest({key:'test',url:'http://manifest.test'});
    const installed = globalThis.fetch;
    assert.notEqual(installed, original);
    cjs.manifest({key:'test',url:'http://manifest.test'});
    assert.equal(globalThis.fetch, installed);
  `;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }), '');
});

test('missing key does not install and invalid configuration is rejected', () => {
  const script = `
    import assert from 'node:assert/strict';
    import {manifest} from './dist/index.js';
    delete process.env.MNFST_KEY;
    const original = fetch;
    manifest(); assert.equal(fetch, original);
    assert.throws(() => manifest({key:'test',url:'file:///tmp'}), TypeError);
    assert.equal(fetch, original);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' });
});

test('register entry installs before the main module evaluates', async () => {
  // A fetch bound at module top level, the way an SDK client binds it in its constructor.
  const provider = await server(async (req, res) => {
    const body = await jsonBody(req) as Record<string, unknown>;
    reply(res, 'temperature' in body ? 400 : 200, 'temperature' in body ? { error: 'temperature unsupported' } : { ok: true, received: body });
  });
  const captures: unknown[] = [];
  const stub = await server(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/heal') {
      const capture = await jsonBody(req) as { request: { body: Record<string, unknown> } };
      captures.push(capture);
      const { temperature, ...rest } = capture.request.body;
      return reply(res, 200, { status: 'patched', issueId: 'i', healAttemptId: 'a', healedRequest: { body: rest } });
    }
    reply(res, 200, {});
  });
  try {
    const script = `
      const bound = globalThis.fetch;
      const res = await bound(process.env.PROVIDER + '/v1/orders', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', temperature: 0.2 }) });
      console.log(res.status, JSON.stringify((await res.json()).received));
    `;
    // Async: the child talks to servers in this process, so the event loop must keep turning.
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', './dist/register.js', '--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, MNFST_KEY: 'test', MNFST_URL: stub.url, PROVIDER: provider.url },
    });
    assert.equal(stdout.trim(), '200 {"model":"m"}');
    assert.equal(captures.length, 1);
  } finally {
    await provider.close(); await stub.close();
  }
});

test('register entry without a key installs nothing', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { manifest } from './dist/index.js';
    const seen = globalThis.fetch;
    manifest({ key: 'test', url: 'http://manifest.test' });
    assert.notEqual(globalThis.fetch, seen);
  `;
  const env = { ...process.env }; delete env.MNFST_KEY;
  execFileSync(process.execPath, ['--import', './dist/register.js', '--input-type=module', '-e', script], { env, stdio: 'pipe' });
});
