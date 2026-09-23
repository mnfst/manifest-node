import { test } from "node:test";
import assert from "node:assert/strict";
import { HealApi, VERSION } from "../src/api.js";
import { ATTEMPT, server, reply, waitFor } from "./helpers.js";
import type { Capture, Fetch } from "../src/types.js";
const capture: Capture = {
  traceId: "test",
  request: {
    method: "POST",
    url: "https://example.com",
    headers: {},
    body: {},
  },
  response: { statusCode: 400, body: "bad", truncated: false },
  responseTimeMs: 1,
};

test("heal calls have a wall-clock deadline", async (t) => {
  const service = await server(() => {});
  t.after(service.close);
  const api = new HealApi(fetch, "key", service.url + "/", 30);
  const started = performance.now();
  assert.equal(await api.heal(capture, new AbortController().signal), null);
  assert.ok(performance.now() - started < 1000);
});

test("rejects oversized heal responses", async (t) => {
  const service = await server((_req, res) =>
    reply(res, 200, { status: "patched", extra: "x".repeat(1_100_000) })
  );
  t.after(service.close);
  const api = new HealApi(fetch, "key", service.url + "/");
  assert.equal(await api.heal(capture, new AbortController().signal), null);
});

test("outcome failures emit warnings", async (t) => {
  const warnings: string[] = [];
  t.mock.method(process, "emitWarning", (message: string) => {
    warnings.push(message);
  });
  const service = await server((_req, res) => reply(res, 400, {}));
  t.after(service.close);
  const api = new HealApi(fetch, "key", service.url + "/");
  api.report(ATTEMPT, { response: { statusCode: 200 } });
  await waitFor(() => warnings.length === 1);
  assert.equal(warnings.length, 1);
});

test("outcome concurrency is bounded", async (t) => {
  let dropped = 0;
  t.mock.method(process, "emitWarning", (message: string) => {
    if (message.includes("capacity")) dropped++;
  });
  const service = await server(() => {});
  t.after(service.close);
  const api = new HealApi(fetch, "key", service.url + "/", 1000, 100);
  for (let i = 0; i < 70; i++)
    api.report(ATTEMPT, { response: { statusCode: 200 } });
  assert.equal(dropped, 6);
  assert.ok(api.pending.size <= 64);
  await waitFor(() => api.pending.size === 0, 5000);
});

// The app derives a request's `sdk`/`sdk_version` from this header and nothing else,
// falling back to the captured exchange's own User-Agent — which never matches — so a
// dropped header costs attribution silently rather than failing a call.
test("heal requests identify the SDK by User-Agent", async (t) => {
  let userAgent: string | undefined;
  const service = await server((req, res) => {
    userAgent = req.headers["user-agent"];
    reply(res, 200, { status: "unverified", healAttemptId: ATTEMPT });
  });
  t.after(service.close);
  const api = new HealApi(fetch, "key", service.url + "/");
  await api.heal(capture, new AbortController().signal);
  assert.equal(userAgent, `mnfst-node/${VERSION}`);
});

test("outcome reports identify the SDK by User-Agent", async (t) => {
  let userAgent: string | undefined;
  const service = await server((req, res) => {
    userAgent = req.headers["user-agent"];
    reply(res, 200, { status: "recorded" });
  });
  t.after(service.close);
  const api = new HealApi(fetch, "key", service.url + "/");
  api.report(ATTEMPT, { response: { statusCode: 200 } });
  await waitFor(() => api.pending.size === 0);
  assert.equal(userAgent, `mnfst-node/${VERSION}`);
});

test("hello announces the install without blocking or throwing", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = new HealApi(
    (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('{"status":"ok"}', { status: 200 });
    }) as unknown as Fetch,
    "k",
    "https://api.example.test/"
  );

  // Returns synchronously: a handshake must never delay startup.
  assert.equal(api.hello("node-22.0.0"), undefined);
  await new Promise((r) => setImmediate(r));

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, "https://api.example.test/v1/hello");
  assert.equal(call.init.method, "POST");
  // Carries the runtime and nothing else — identity rides in the user-agent.
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    runtime: "node-22.0.0",
  });
  const headers = call.init.headers as Record<string, string>;
  assert.match(String(headers["user-agent"]), /^mnfst-node\//);
});

test("a failing hello is swallowed", async () => {
  const api = new HealApi(
    (async () => {
      throw new Error("network down");
    }) as unknown as Fetch,
    "k",
    "https://api.example.test/"
  );
  // An app that cannot reach Manifest must still boot cleanly.
  assert.equal(api.hello("node-22.0.0"), undefined);
  await new Promise((r) => setImmediate(r));
});

test("sendRequests throws only when a retry could help", async (t) => {
  let status = 202;
  let body: unknown = { accepted: 1 };
  const service = await server((_req, res) => reply(res, status, body));
  t.after(service.close);
  const api = new HealApi(fetch, "key", service.url + "/");
  const call = { traceId: "t", method: "GET", url: "https://a.com/x", statusCode: 200,
    responseTimeMs: 1, occurredAt: new Date(0).toISOString() };
  for (status of [202, 400, 401, 404]) await api.sendRequests([call]);
  for (status of [429, 500, 503]) await assert.rejects(api.sendRequests([call]));
  status = 403; body = { error: "project_disabled" };
  await api.sendRequests([call]);
  assert.equal(api.enabled(), false);
});
