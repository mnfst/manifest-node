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

test('never has two sends in flight, even while flush() runs', async () => {
  let active = 0; let most = 0;
  const buf = new CallBuffer(async () => {
    active++; most = Math.max(most, active);
    await new Promise(r => setTimeout(r, 30));
    active--;
  }, { intervalMs: 5, minGapMs: 0 });
  for (let i = 0; i < 2000; i++) buf.record(call(i));
  const flushing = buf.flush();
  for (let i = 0; i < 1000; i++) buf.record(call(i)); // past flushAt while flushing
  await flushing;
  assert.equal(most, 1);
  buf.stop();
});

test('flush(deadline) gives up on a hanging server at the deadline', async () => {
  let aborted = 0;
  const buf = new CallBuffer((_batch, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); });
  }), { intervalMs: 60_000, minGapMs: 0 });
  for (let i = 0; i < 5000; i++) buf.record(call(i));
  const started = performance.now();
  await buf.flush(200);
  assert.ok(performance.now() - started < 1000, `took ${performance.now() - started} ms`);
  assert.equal(aborted, 1); // aborted once, never retried
  buf.stop();
});

test('immediate: sends the first call at once and hands the send to keepAlive', async () => {
  const sent: TrackedCall[][] = []; const kept: Promise<unknown>[] = [];
  const buf = new CallBuffer(async b => { sent.push(b); },
    { intervalMs: 60_000, minGapMs: 0, immediate: true, keepAlive: p => { kept.push(p); } });
  buf.record(call(1));
  assert.equal(kept.length, 1);
  await Promise.all(kept);
  assert.deepEqual(sent.map(b => b.length), [1]);
  buf.stop();
});

test('immediate: calls recorded during a send ride the same drain, batched', async () => {
  const sent: TrackedCall[][] = []; const kept: Promise<unknown>[] = [];
  const buf = new CallBuffer(async b => { sent.push(b); await new Promise(r => setTimeout(r, 30)); },
    { intervalMs: 60_000, minGapMs: 0, immediate: true, keepAlive: p => { kept.push(p); } });
  buf.record(call(1));
  for (let i = 2; i <= 5; i++) buf.record(call(i));
  await Promise.all(kept);
  assert.equal(kept.length, 1);
  assert.deepEqual(sent.map(b => b.length), [1, 4]);
  buf.stop();
});

test('immediate: a call recorded as a drain settles starts the next one', async () => {
  const sent: TrackedCall[][] = []; const kept: Promise<unknown>[] = [];
  const buf = new CallBuffer(async b => { sent.push(b); },
    { intervalMs: 60_000, minGapMs: 0, immediate: true, keepAlive: p => { kept.push(p); } });
  buf.record(call(1));
  await kept[0];
  buf.record(call(2));
  await Promise.all(kept);
  assert.equal(kept.length, 2);
  assert.deepEqual(sent.map(b => b.length), [1, 1]);
  buf.stop();
});
