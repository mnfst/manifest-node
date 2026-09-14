import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { Capture, HealResult, Outcome } from '../src/types.js';
import { Runtime } from '../src/runtime.js';
export const ATTEMPT = '33333333-3333-4333-8333-333333333333';
export const error = { error: { message: 'range of limit should be [1, 100]', param: 'limit', code: 'invalid_value', type: 'validation_error' } };
export async function jsonBody(request: IncomingMessage) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString() || 'null');
}
export function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
}
export async function server(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const instance = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { if (!res.headersSent) reply(res, 500, { error: 'fixture error' }); else res.destroy(); }); });
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    const done = new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
    instance.closeAllConnections(); await done;
  } };
}
export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}
export async function rig() {
  const captures: Capture[] = []; const outcomes: Outcome[] = [];
  const requests: { path: string; body: any; headers: IncomingMessage['headers'] }[] = [];
  const config: { result: HealResult; disabled: boolean; reportStatus: number; finish?: () => void } = {
    result: { status: 'unverified', healAttemptId: ATTEMPT, healedRequest: { body: { limit: 100 } } }, disabled: false, reportStatus: 200,
  };
  const api = await server(async (req, res) => {
    const body = await jsonBody(req);
    if (req.url === '/v1/heal') {
      captures.push(body); reply(res, config.disabled ? 403 : 200, config.disabled ? { error: 'project_disabled' } : config.result);
    } else if (req.url === `/v1/heal-attempts/${ATTEMPT}`) {
      const keys = Object.keys(body);
      const valid = keys.length === 1 && (keys[0] === 'response' ? body.response.statusCode >= 200 && body.response.statusCode <= 599 :
        keys[0] === 'failure' && ['transport_error', 'not_attempted'].includes(body.failure.kind));
      if (!valid) { reply(res, 400, { error: 'contract mismatch' }); return; }
      outcomes.push(body); reply(res, config.reportStatus, { status: 'recorded' });
    } else reply(res, 404, {});
  });
  const provider = await server(async (req, res) => {
    const body = await jsonBody(req); const path = req.url!;
    requests.push({ path, body, headers: req.headers });
    if (body?.limit > 100 || path.startsWith('/same')) { reply(res, 400, error); return; }
    if (path.startsWith('/transport')) { res.destroy(); return; }
    if (path.startsWith('/stream')) {
      res.writeHead(200, { 'content-type': 'text/plain' }); res.write('first');
      config.finish = () => res.end('last'); return;
    }
    reply(res, 200, { received: body });
  });
  const runtime = new Runtime({ key: 'project-key', url: api.url + '/' }, fetch);
  return { api, provider, runtime, config, captures, outcomes, requests,
    close: async () => { await waitFor(() => runtime.api.pending.size === 0); await Promise.all([api.close(), provider.close()]); } };
}
