import { randomUUID } from 'node:crypto';
import { HealApi, warn } from './api.js';
import { captureRequest, captureResponse } from './capture.js';
import { CallBuffer } from './tracking.js';
import { isObject, mergeBody, safeHeaders, safeUrl, serializeRequestBody, trackedUrl, travelingBody, TRANSPORT_ERROR } from './wire.js';
import type { Capture, Fetch, HealResult, ManifestOptions } from './types.js';
// Only request-side failures are worth capturing. The forbidden statuses are
// the ones editing the request cannot fix: 401/403 (auth), 402 (billing),
// 429 (rate limits) and, via the upper bound, every 5xx. Everything else in
// 4xx is fair game -- 409, 413, 415 and 451 all describe a request the server
// refused to accept.
const forbidden = new Set([401, 402, 403, 429]);
// A patch that merges to nothing still retries on these, bodyless; any other
// method needs a body to replay. GET and HEAD may never carry one at all --
// fetch rejects it, and CDNs answer 403 to a bodied GET.
const bodyless = ['GET', 'HEAD', 'DELETE', 'OPTIONS'];
const neverBodied = (method: string) => method === 'GET' || method === 'HEAD';
export const eligible = (status: number): boolean =>
  status >= 400 && status < 500 && !forbidden.has(status);
export interface ResolvedOptions extends ManifestOptions { key: string; url: string }

export class Runtime {
  readonly api: HealApi;
  /** Calls that did not go to `/v1/heal`, any status, on their way to `/v1/requests`. */
  readonly tracker: CallBuffer;
  constructor(readonly options: ResolvedOptions, private original: Fetch, api?: HealApi) {
    this.api = api ?? new HealApi(original, options.key, options.url);
    this.tracker = new CallBuffer(batch => this.api.sendRequests(batch));
  }
  /**
   * Record a call that is not being healed. An in-memory append: never awaited,
   * never throws, reads nothing of the response.
   */
  track(method: string, url: () => string, statusCode: number, startedAt: number, responseTimeMs: number): void {
    try {
      const reported = trackedUrl(url());
      if (!reported || statusCode < 100 || statusCode > 599) return;
      this.tracker.record({ traceId: randomUUID(), method, url: reported, statusCode,
        responseTimeMs: Math.round(responseTimeMs), occurredAt: new Date(startedAt).toISOString() });
    } catch { /* tracking never fails the caller's request */ }
  }
  readonly fetch: Fetch = async (input, init) => {
    // Normalize once, consuming Request inputs in the same way fetch does.
    const request = new Request(input, init);
    const extras = { ...init }; delete extras.body; delete extras.headers;
    // The tee is bounded and runs alongside the outgoing request, never ahead
    // of it without a limit. Its cancellation must not wait for the other tee.
    const bodyPromise = captureRequest(request).catch(() => ({ body: null, complete: false }));
    const startedAt = Date.now();
    const started = performance.now();
    const response = await this.original(request, extras);
    const responseTimeMs = performance.now() - started;
    if (!eligible(response.status) || response.redirected || !this.api.enabled()) {
      this.track(request.method, () => request.url, response.status, startedAt, responseTimeMs);
      return response;
    }
    return this.handleResponse(request, response, await bodyPromise, responseTimeMs, extras);
  };
  async handleResponse(request: Request, response: Response, body: { body: unknown; complete: boolean },
    responseTimeMs: number, extras: RequestInit = {}): Promise<Response> {
    if (!eligible(response.status) || response.redirected || !this.api.enabled()) return response;
    return this.repair(request, extras, response, body, responseTimeMs);
  }
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
    const contentType = headers.get('content-type');
    headers.delete('content-length');
    if (healed.headers !== undefined && !isObject(healed.headers)) return null;
    for (const [name, value] of Object.entries(healed.headers ?? {})) {
      if (value === null) headers.delete(name);
      else if (typeof value === 'string') headers.set(name, value);
      else return null;
    }
    const body = Object.hasOwn(healed, 'body') ? mergeBody(originalBody, healed.body) : originalBody;
    // Never invent a replay of a binary or streamed upload when its original
    // data was not captured as a supported structured body.
    if (body === null && !bodyless.includes(request.method)) return null;
    return new Request(url, {
      method: request.method, headers,
      body: body === null || neverBodied(request.method) ? undefined : serializeRequestBody(body, contentType),
      signal: request.signal, redirect: request.redirect, credentials: request.credentials,
      cache: request.cache, integrity: request.integrity, keepalive: request.keepalive,
      mode: request.mode, referrer: request.referrer, referrerPolicy: request.referrerPolicy,
    });
  } catch { return null; }
}
