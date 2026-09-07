export interface ManifestOptions {
  key?: string;
  url?: string;
  onHeal?: (event: HealEvent) => void | Promise<void>;
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
