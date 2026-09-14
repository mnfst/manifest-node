import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/api.js';

test('runtime version matches the package version', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(VERSION, packageJson.version);
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
