import { randomUUID } from 'node:crypto';
import { HealApi, warn } from './api.js';
import { captureRequest, captureResponse } from './capture.js';
import { isObject, mergeBody, safeHeaders, safeUrl, travelingBody, TRANSPORT_ERROR } from './wire.js';
import type { Capture, Fetch, HealResult, ManifestOptions } from './types.js';
const eligible = new Set([400, 404, 422]);
export interface ResolvedOptions extends ManifestOptions { key: string; url: string }

export class Runtime {
  readonly api: HealApi;
  constructor(readonly options: ResolvedOptions, private original: Fetch, api?: HealApi) {
    this.api = api ?? new HealApi(original, options.key, options.url);
  }
  readonly fetch: Fetch = async (input, init) => {
    // Normalize once, consuming Request inputs in the same way fetch does.
    const request = new Request(input, init);
    const extras = { ...init }; delete extras.body; delete extras.headers;
    // The tee is bounded and runs alongside the outgoing request, never ahead
    // of it without a limit. Its cancellation must not wait for the other tee.
    const bodyPromise = captureRequest(request).catch(() => ({ body: null, complete: false }));
    const started = performance.now();
    const response = await this.original(request, extras);
    if (!eligible.has(response.status) || response.redirected || !this.api.enabled()) return response;
    return this.repair(request, extras, response, await bodyPromise, performance.now() - started);
  };
  private async repair(request: Request, extras: RequestInit, original: Response,
    body: { body: unknown; complete: boolean }, responseTimeMs: number): Promise<Response> {
    let response = original;
    let result: HealResult | null = null;
    const started = performance.now();
    let replayStatusCode: number | null = null;
    let replayAttempted = false;
    try {
      const captured = await captureResponse(response);
      response = captured.response;
      const payload: Capture = {
        traceId: randomUUID(),
        request: { method: request.method, url: safeUrl(request.url), headers: safeHeaders(request.headers), body: travelingBody(body.body) },
        response: { statusCode: response.status, body: captured.body, truncated: captured.truncated },
        responseTimeMs: Math.round(responseTimeMs),
      };
      request.signal.throwIfAborted();
      result = await this.api.heal(payload, request.signal);
      request.signal.throwIfAborted();
      const retry = body.complete && captured.complete ? buildRetry(request, body.body, result) : null;
      if (!retry) {
        this.api.report(result?.healAttemptId, { failure: { kind: 'not_attempted', message: 'replay_not_attempted' } });
        return response;
      }
      replayAttempted = true;
      let retried: Response;
      try { retried = await this.original(retry, extras); }
      catch {
        this.api.report(result?.healAttemptId, { failure: { kind: 'transport_error', message: TRANSPORT_ERROR } });
        request.signal.throwIfAborted();
        return response;
      }
      replayStatusCode = retried.status;
      if (retried.status >= 400) {
        const capturedRetry = await captureResponse(retried);
        retried = capturedRetry.response;
        this.api.report(result?.healAttemptId, { response: { statusCode: retried.status, body: capturedRetry.body, truncated: capturedRetry.truncated } });
      } else {
        this.api.report(result?.healAttemptId, { response: { statusCode: retried.status } });
      }
      void response.body?.cancel().catch(() => {});
      return retried;
    } catch {
      request.signal.throwIfAborted();
      this.api.report(result?.healAttemptId, { failure: { kind: 'not_attempted', message: 'replay_not_attempted' } });
      return response;
    } finally {
      if (this.options.onHeal) {
        try {
          void Promise.resolve(this.options.onHeal({ url: safeUrl(request.url), statusCode: original.status,
            healStatus: replayAttempted && replayStatusCode === null ? 'replay_failed' : result?.status ?? 'heal_unreachable', replayStatusCode,
            healMs: Math.round(performance.now() - started), operations: result?.operations }))
            .catch(() => warn('onHeal callback failed'));
        } catch { warn('onHeal callback failed'); }
      }
    }
  }
}

function buildRetry(request: Request, originalBody: unknown, result: HealResult | null): Request | null {
  if (!result || !['patched', 'unverified'].includes(result.status) || !isObject(result.healedRequest)) return null;
  const healed = result.healedRequest;
  if (!['url', 'headers', 'body'].some(key => Object.hasOwn(healed, key))) return null;
  try {
    const url = new URL(healed.url ?? request.url);
    if (url.origin !== new URL(request.url).origin || url.username || url.password) return null;
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    if (healed.headers !== undefined && !isObject(healed.headers)) return null;
    for (const [name, value] of Object.entries(healed.headers ?? {})) {
      if (value === null) headers.delete(name);
      else if (typeof value === 'string') headers.set(name, value);
      else return null;
    }
    const body = Object.hasOwn(healed, 'body') ? mergeBody(originalBody, healed.body) : originalBody;
    // The app currently repairs JSON bodies. Never invent a replay of a binary
    // or streamed upload when its original data was not captured as JSON.
    if (body === null && !['GET', 'HEAD'].includes(request.method)) return null;
    return new Request(url, {
      method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : JSON.stringify(body),
      signal: request.signal, redirect: request.redirect, credentials: request.credentials,
      cache: request.cache, integrity: request.integrity, keepalive: request.keepalive,
      mode: request.mode, referrer: request.referrer, referrerPolicy: request.referrerPolicy,
    });
  } catch { return null; }
}
