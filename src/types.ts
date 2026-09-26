export interface ManifestOptions {
  key?: string;
  url?: string;
  onHeal?: (event: HealEvent) => void | Promise<void>;
  /**
   * Only these calls reach Manifest. Each entry is a domain (`stripe.com`, subdomains included)
   * or a domain with a path (`stripe.com/v1/charges`). Default: `MNFST_ALLOWLIST`.
   */
  allowlist?: string[] | string;
  /** These calls never reach Manifest; same entries as `allowlist`, and it wins. Default: `MNFST_DENYLIST`. */
  denylist?: string[] | string;
}
export interface HealEvent {
  url: string;
  statusCode: number;
  healStatus: string;
  replayStatusCode: number | null;
  healMs: number;
  operations?: unknown[];
}
export interface Capture {
  traceId: string;
  request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  response: { statusCode: number; body: unknown; truncated: boolean };
  responseTimeMs: number;
}
export interface HealResult {
  status: string;
  healAttemptId?: string;
  operations?: unknown[];
  healedRequest?: { url?: string; headers?: Record<string, string | null>; body?: unknown };
}
export type Outcome =
  | { response: { statusCode: number; body?: unknown; truncated?: boolean } }
  | { failure: { kind: 'transport_error' | 'not_attempted'; message?: string } };
export type Fetch = typeof globalThis.fetch;
/**
 * One call the SDK saw and did not send to `/v1/heal`, any status. Metadata
 * only: the URL carries no query, userinfo or fragment, and nothing of the
 * request or response body is sent.
 */
export interface TrackedCall {
  traceId: string;
  method: string;
  url: string;
  statusCode: number;
  responseTimeMs: number | null;
  occurredAt: string;
}
