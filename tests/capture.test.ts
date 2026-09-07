import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureResponse } from '../src/capture.js';
import { boundedJson, mergeBody, safeUrl } from '../src/wire.js';

test('bounded prefix replays every original byte', async () => {
  let reads = 0;
  const original = new Response(new ReadableStream({ pull(controller) {
    if (reads === 10) { controller.close(); return; }
    reads++; controller.enqueue(new Uint8Array(32768).fill(65));
  } }, { highWaterMark: 0 }), { status: 400 });
  const captured = await captureResponse(original);
  assert.equal(captured.truncated, true); assert.equal(reads, 3);
  assert.equal((await captured.response.arrayBuffer()).byteLength, 327680);
});

test('slow prefix returns without losing the pending read', async () => {
  let finish: (() => void) | undefined;
  const original = new Response(new ReadableStream({ start(controller) {
    finish = () => { controller.enqueue(new TextEncoder().encode('late')); controller.close(); };
  } }), { status: 400 });
  const captured = await captureResponse(original, 65536, 10);
  assert.equal(captured.truncated, true);
  finish!(); assert.equal(await captured.response.text(), 'late');
});

test('stream errors remain errors for the caller', async () => {
  const original = new Response(new ReadableStream({ pull(controller) { controller.error(new Error('broken stream')); } }), { status: 400 });
  const captured = await captureResponse(original);
  await assert.rejects(captured.response.text(), /broken stream/);
});

test('JSON depth is bounded and credential restoration is prototype-safe', () => {
  let value: unknown = {};
  for (let i = 0; i < 70; i++) value = { child: value };
  assert.equal(boundedJson(value), false);
  const result = mergeBody(JSON.parse('{"apiKey":"secret","old":true}'), JSON.parse('{"__proto__":{"polluted":true},"new":true}'));
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { apiKey: 'secret', ...JSON.parse('{"__proto__":{"polluted":true},"new":true}') });
  assert.equal(safeUrl('https://u:p@example.com/path?token=secret#private'), 'https://example.com/path?token=REDACTED');
});
