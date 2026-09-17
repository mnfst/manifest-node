import { captureResponse } from './capture.js';
import { boundedJson, isObject } from './wire.js';
import type { Capture, Fetch, HealResult, Outcome } from './types.js';
export const VERSION = '7.0.0';
export const warn = (message: string) => process.emitWarning(message, { code: 'MNFST' });
export class HealApi {
  private disabledUntil = 0;
  private inFlight = 0;
  /** @internal In-flight outcome reports; exposed so tests can await delivery. */
  readonly pending = new Set<Promise<void>>();
  constructor(private rawFetch: Fetch, private key: string, private url: string,
    private timeoutMs = 60_000, private reportTimeoutMs = 5000) {}
  enabled() { return performance.now() >= this.disabledUntil; }
  private headers() {
    return { authorization: `Bearer ${this.key}`, 'content-type': 'application/json',
      'user-agent': `mnfst-node/${VERSION}` };
  }
  async heal(capture: Capture, signal: AbortSignal): Promise<HealResult | null> {
    if (!this.enabled() || this.inFlight >= 8) return null;
    this.inFlight++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.rawFetch(new URL('v1/heal', this.url), {
        method: 'POST', headers: this.headers(), body: JSON.stringify(capture),
        signal: AbortSignal.any([signal, controller.signal]), redirect: 'error',
      });
      if (response.status !== 200 && response.status !== 403) {
        void response.body?.cancel().catch(() => {});
        return null;
      }
      const captured = await captureResponse(response, 1_048_576, this.timeoutMs);
      void captured.response.body?.cancel().catch(() => {});
      if (!captured.complete || !isObject(captured.body) || !boundedJson(captured.body)) return null;
      if (response.status === 403 && captured.body.error === 'project_disabled') {
        this.disabledUntil = performance.now() + 300_000;
      }
      if (response.status !== 200 || typeof captured.body.status !== 'string') return null;
      return {
        status: captured.body.status,
        ...(typeof captured.body.healAttemptId === 'string' ? { healAttemptId: captured.body.healAttemptId } : {}),
        ...(Array.isArray(captured.body.operations) ? { operations: captured.body.operations } : {}),
        ...(isObject(captured.body.healedRequest) ? { healedRequest: captured.body.healedRequest } : {}),
      };
    } catch { return null; }
    finally { clearTimeout(timer); this.inFlight--; }
  }
  report(id: string | undefined, outcome: Outcome): void {
    if (!id) return;
    if (this.pending.size >= 64) { warn('Outcome report capacity reached; report dropped'); return; }
    const promise = this.send(id, outcome);
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise));
  }
  private async send(id: string, outcome: Outcome): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.reportTimeoutMs);
    try {
      const response = await this.rawFetch(new URL(`v1/heal-attempts/${encodeURIComponent(id)}`, this.url), {
        method: 'PATCH', headers: this.headers(), body: JSON.stringify(outcome),
        signal: controller.signal, redirect: 'error',
      });
      void response.body?.cancel().catch(() => {});
      if (!response.ok) warn('Outcome report rejected; attempt remains unconfirmed');
    } catch { warn('Outcome report failed; attempt remains unconfirmed'); }
    finally { clearTimeout(timer); }
  }
}
