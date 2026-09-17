import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, maskKey, parseArgs, render, runDoctor, type DoctorReport } from '../src/cli.js';
import { jsonBody, reply, server } from './helpers.js';

const KEY = 'mnfst_proj_000000000000DZDw';

function check(report: DoctorReport, label: string) {
  const found = report.checks.find((entry) => entry.label === label);
  assert.ok(found, `missing check: ${label}`);
  return found;
}

async function project(scripts?: Record<string, string>, dependencies?: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-doctor-'));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', scripts, dependencies }));
  return dir;
}

test('maskKey reveals a prefix and the last four, never the key', () => {
  const masked = maskKey(KEY);
  assert.equal(masked, 'mnfst_proj_…DZDw');
  assert.ok(!masked.includes(KEY));
  assert.ok(!masked.includes('000000000000'));
  assert.equal(maskKey('short'), '…');
});

test('doctor validates the key, reports the project and detects preload', async (t) => {
  const calls: { url: string | undefined; body: any; authorization?: string; userAgent?: string }[] = [];
  const api = await server(async (req, res) => {
    calls.push({
      url: req.url,
      body: await jsonBody(req),
      authorization: req.headers.authorization,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    });
    if (req.url === '/v1/hello') return reply(res, 200, { project: { name: 'Find Concierge' }, requests: 3 });
    reply(res, 404, {});
  });
  const dir = await project({ start: 'node --require manifest/register app.js' });
  t.after(async () => { await api.close(); await rm(dir, { recursive: true, force: true }); });

  const report = await runDoctor({
    cwd: dir, env: { MNFST_KEY: KEY, MNFST_URL: api.url }, fetch, sdkVersion: '7.0.0',
  });

  assert.equal(report.ok, true);
  assert.deepEqual(check(report, 'SDK installed'), { label: 'SDK installed', status: 'ok', detail: 'manifest 7.0.0' });
  assert.deepEqual(check(report, 'MNFST_KEY set'), { label: 'MNFST_KEY set', status: 'ok', detail: 'mnfst_proj_…DZDw' });
  assert.deepEqual(check(report, 'Key valid'), { label: 'Key valid', status: 'ok', detail: 'project "Find Concierge"' });
  assert.deepEqual(check(report, 'Requests received'), { label: 'Requests received', status: 'ok', detail: '3 requests received' });
  assert.equal(check(report, 'Preload active').status, 'ok');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, '/v1/hello');
  assert.deepEqual(calls[0]!.body, { runtime: `node-${process.versions.node}` });
  assert.equal(calls[0]!.authorization, `Bearer ${KEY}`);
  assert.match(calls[0]!.userAgent ?? '', /^mnfst-node\//);
  // The key is masked everywhere it is printed.
  assert.ok(!render(report).includes(KEY));
});

test('a rejected key fails the key check', async (t) => {
  const api = await server((_req, res) => reply(res, 401, { error: 'invalid_key' }));
  const dir = await project({ start: 'node app.js' });
  t.after(async () => { await api.close(); await rm(dir, { recursive: true, force: true }); });

  const report = await runDoctor({ cwd: dir, env: { MNFST_KEY: KEY, MNFST_URL: api.url }, fetch, sdkVersion: '7.0.0' });
  assert.equal(report.ok, false);
  assert.equal(check(report, 'Key valid').status, 'fail');
  assert.match(check(report, 'Key valid').detail, /rejected/);
});

test('a disabled project is distinguished from a bad key', async (t) => {
  const api = await server((_req, res) => reply(res, 403, { error: 'project_disabled' }));
  const dir = await project({ start: 'node app.js' });
  t.after(async () => { await api.close(); await rm(dir, { recursive: true, force: true }); });

  const report = await runDoctor({ cwd: dir, env: { MNFST_KEY: KEY, MNFST_URL: api.url }, fetch, sdkVersion: '7.0.0' });
  assert.match(check(report, 'Key valid').detail, /disabled/);
});

test('an unreachable server fails the key check without throwing', async (t) => {
  const dir = await project({ start: 'node app.js' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const offline = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;

  const report = await runDoctor({ cwd: dir, env: { MNFST_KEY: KEY, MNFST_URL: 'https://api.example.test' }, fetch: offline, sdkVersion: '7.0.0' });
  assert.equal(report.ok, false);
  assert.deepEqual(check(report, 'Key valid'), { label: 'Key valid', status: 'fail', detail: 'could not be reached at https://api.example.test/' });
});

test('no key skips validation and still reports coverage', async (t) => {
  const dir = await project();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const report = await runDoctor({ cwd: dir, env: {}, sdkVersion: '7.0.0' });
  assert.equal(report.ok, false);
  assert.equal(check(report, 'MNFST_KEY set').status, 'fail');
  assert.deepEqual(check(report, 'Key valid'), { label: 'Key valid', status: 'skip', detail: '' });
  assert.match(render(report), /Edge runtime/);
});

test('zero requests is a warning, not a failure', async (t) => {
  const api = await server((_req, res) => reply(res, 200, { projectName: 'Quiet App', requests: 0 }));
  const dir = await project({ start: 'node -r manifest/register app.js' });
  t.after(async () => { await api.close(); await rm(dir, { recursive: true, force: true }); });

  const report = await runDoctor({ cwd: dir, env: { MNFST_KEY: KEY, MNFST_URL: api.url }, fetch, sdkVersion: '7.0.0' });
  assert.equal(report.ok, true);
  assert.deepEqual(check(report, 'Key valid').detail, 'project "Quiet App"');
  assert.deepEqual(check(report, 'Requests received'), { label: 'Requests received', status: 'warn', detail: 'no requests received yet' });
});

test('a start script without preload is a failure, and Next.js asks for instrumentation', async (t) => {
  const plain = await project({ start: 'next start' });
  const next = await project({ start: 'next start' }, { next: '15.0.0' });
  t.after(async () => {
    await Promise.all([plain, next].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const plainReport = await runDoctor({ cwd: plain, env: {}, sdkVersion: '7.0.0' });
  assert.equal(check(plainReport, 'Preload active').status, 'fail');
  assert.match(check(plainReport, 'Preload active').detail, /no NODE_OPTIONS/);

  const nextReport = await runDoctor({ cwd: next, env: {}, sdkVersion: '7.0.0' });
  assert.equal(check(nextReport, 'Preload active').status, 'fail');
  assert.match(check(nextReport, 'Preload active').detail, /instrumentation/);
});

test('instrumentation.ts counts as a Next.js install', async (t) => {
  const dir = await project({ start: 'next start' }, { next: '15.0.0' });
  await writeFile(path.join(dir, 'instrumentation.ts'), "export async function register() {\n  const { manifest } = await import('manifest');\n  manifest();\n}\n");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const report = await runDoctor({ cwd: dir, env: {}, sdkVersion: '7.0.0' });
  assert.deepEqual(check(report, 'Preload active'), { label: 'Preload active', status: 'ok', detail: 'instrumentation.ts installs Manifest before the app runs' });
});

test('--send-test posts one synthetic capture', async (t) => {
  const heals: any[] = [];
  const api = await server(async (req, res) => {
    if (req.url === '/v1/hello') return reply(res, 200, { project: 'App' });
    if (req.url === '/v1/heal') { heals.push(await jsonBody(req)); return reply(res, 200, { status: 'patched' }); }
    reply(res, 404, {});
  });
  const dir = await project({ start: 'node -r manifest/register app.js' });
  t.after(async () => { await api.close(); await rm(dir, { recursive: true, force: true }); });

  const report = await runDoctor({ cwd: dir, env: { MNFST_KEY: KEY, MNFST_URL: api.url }, fetch, sdkVersion: '7.0.0', sendTest: true });
  assert.equal(report.ok, true);
  assert.equal(check(report, 'Test request sent').status, 'ok');
  assert.equal(heals.length, 1);
  assert.equal(heals[0].synthetic, true);
  assert.equal(heals[0].response.statusCode, 400);
});

test('parseArgs understands the doctor flags and rejects unknown options', () => {
  assert.deepEqual(parseArgs(['doctor', '--send-test']), { command: 'doctor', sendTest: true, help: false, version: false });
  assert.deepEqual(parseArgs(['doctor', '--url=https://x.test', '-h']), { command: 'doctor', url: 'https://x.test', sendTest: false, help: true, version: false });
  assert.throws(() => parseArgs(['doctor', '--nope']), /unknown option/);
});

test('main runs doctor and returns a failing exit code for a bad key', async (t) => {
  const api = await server((_req, res) => reply(res, 401, {}));
  const previousKey = process.env.MNFST_KEY;
  const previousUrl = process.env.MNFST_URL;
  process.env.MNFST_KEY = KEY;
  process.env.MNFST_URL = api.url;
  t.after(async () => {
    await api.close();
    if (previousKey === undefined) delete process.env.MNFST_KEY; else process.env.MNFST_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.MNFST_URL; else process.env.MNFST_URL = previousUrl;
  });

  assert.equal(await main(['doctor']), 1);
  assert.equal(await main(['--version']), 0);
  assert.equal(await main(['bogus']), 1);
});
