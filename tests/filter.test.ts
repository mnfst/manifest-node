import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isExcluded, parseRule, resolveFilter } from '../src/filter.js';

// Shared with the Python, PHP and Hermes SDKs: the same file, the same answers.
const cases = JSON.parse(readFileSync(new URL('./fixtures/url-filter.json', import.meta.url), 'utf8'));

test('parses every shared entry the same way', () => {
  for (const c of cases.parse) {
    const blank = c.entry.trim() === '';
    const { invalid } = resolveFilter({ denylist: [c.entry] }, {});
    assert.deepEqual(blank ? null : parseRule(c.entry), c.rule, c.entry);
    assert.equal(invalid.length > 0, Boolean(c.invalid), c.entry);
  }
});
test('matches every shared URL the same way', () => {
  for (const c of cases.match) {
    const { filter } = resolveFilter({ allowlist: c.allow, denylist: c.deny }, {});
    assert.equal(isExcluded(filter, c.url), c.excluded, JSON.stringify(c));
  }
});
test('an option beats the env var, but a blank option falls back to it', () => {
  const env = { MNFST_DENYLIST: 'env.com', MNFST_ALLOWLIST: 'a.com/v1' };
  assert.deepEqual(resolveFilter({}, env).filter,
    { allow: [{ host: 'a.com', path: '/v1' }], deny: [{ host: 'env.com', path: null }] });
  assert.deepEqual(resolveFilter({ denylist: ['opt.com'] }, env).filter.deny, [{ host: 'opt.com', path: null }]);
  assert.deepEqual(resolveFilter({ denylist: '', allowlist: [' '] }, env).filter, resolveFilter({}, env).filter);
});
test('reports the entries it dropped', () => {
  assert.deepEqual(resolveFilter({ allowlist: 'stripe.com, stripe.com/v1/*' }, {}).invalid, ['stripe.com/v1/*']);
});
