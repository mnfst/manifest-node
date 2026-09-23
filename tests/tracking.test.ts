import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallBuffer } from '../src/tracking.js';
import type { TrackedCall } from '../src/types.js';

const call = (i: number): TrackedCall => ({
  traceId: `t${i}`, method: 'GET', url: 'https://a.com/x', statusCode: 200,
  responseTimeMs: 1, occurredAt: new Date(0).toISOString(),
});

test('sends at 500 calls in one batch', async () => {
  const sent: TrackedCall[][] = [];
  const buf = new CallBuffer(async b => { sent.push(b); }, { intervalMs: 60_000, minGapMs: 0 });
  for (let i = 0; i < 500; i++) buf.record(call(i));
  await buf.idle();
  assert.deepEqual(sent.map(b => b.length), [500]);
  buf.stop();
});

test('drops past 5000 buffered calls and never throws', () => {
  const buf = new CallBuffer(() => new Promise(() => {}), { intervalMs: 60_000 }); // send hangs
  for (let i = 0; i < 50_000; i++) buf.record(call(i));
  assert.ok(buf.size() <= 5000);
  buf.stop();
});

test('never sends twice within minGapMs', async () => {
  const at: number[] = [];
  const buf = new CallBuffer(async () => { at.push(performance.now()); }, { intervalMs: 60_000, minGapMs: 200 });
  for (let i = 0; i < 2000; i++) buf.record(call(i)); // four batches' worth
  await buf.flush();
  assert.equal(at.length, 4);
  for (let i = 1; i < at.length; i++) assert.ok(at[i]! - at[i - 1]! >= 190, `gap ${at[i]! - at[i - 1]!}`);
  buf.stop();
});

test('a failed batch is retried once, then dropped', async () => {
  let calls = 0;
  const buf = new CallBuffer(async () => { calls++; throw new Error('down'); }, { intervalMs: 60_000, minGapMs: 0 });
  for (let i = 0; i < 500; i++) buf.record(call(i));
  await buf.flush(); // must not reject
  assert.equal(calls, 2);
  assert.equal(buf.size(), 0);
  buf.stop();
});

test('flush() sends what is left, in batches of at most 500', async () => {
  const sent: TrackedCall[][] = [];
  const buf = new CallBuffer(async b => { sent.push(b); }, { intervalMs: 60_000, flushAt: 10_000, minGapMs: 0 });
  for (let i = 0; i < 900; i++) buf.record(call(i));
  await buf.flush();
  assert.deepEqual(sent.map(b => b.length), [500, 400]);
  buf.stop();
});

test('the interval sends a small batch without waiting for 500', async () => {
  const sent: TrackedCall[][] = [];
  const buf = new CallBuffer(async b => { sent.push(b); }, { intervalMs: 20, minGapMs: 0 });
  buf.record(call(1));
  const deadline = performance.now() + 1000;
  while (sent.length === 0 && performance.now() < deadline) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(sent.map(b => b.length), [1]);
  buf.stop();
});
