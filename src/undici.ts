import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { Runtime } from './runtime.js';

/**
 * Calls made through the undici package directly (`@vercel/blob`, and any
 * client that imports undici's fetch or request) never pass through
 * `globalThis.fetch` or `node:http`, so neither patch sees them. Node's own
 * fetch and the undici package both publish every request on the same
 * diagnostics channels, so watching those covers them all, and a fetch
 * captured before `manifest()` ran as well.
 *
 * Observation only: a channel sees a response and cannot replace it, so these
 * calls are tracked, never healed.
 */

// Set while the runtime's own fetch is at work, so a call it already handles
// (and its retry) is not counted a second time by the channels below.
const handling = new AsyncLocalStorage<true>();

export const handled = <T>(work: () => T): T => handling.run(true, work);

interface UndiciRequest { method?: string; origin?: unknown; path?: string }
interface Started { startedAt: number; started: number }

export function installUndici(runtime: Runtime): () => void {
  const manifestOrigin = new URL(runtime.options.url).origin;
  const inFlight = new WeakMap<object, Started>();
  const onCreate = (message: unknown) => {
    const { request } = message as { request: UndiciRequest };
    // Manifest's own sends go out through Node's fetch too; tracking them
    // would make every batch of tracked calls produce another.
    if (handling.getStore() || String(request.origin) === manifestOrigin) return;
    inFlight.set(request, { startedAt: Date.now(), started: performance.now() });
  };
  const onHeaders = (message: unknown) => {
    const { request, response } = message as { request: UndiciRequest; response: { statusCode: number } };
    const started = inFlight.get(request);
    if (!started) return;
    inFlight.delete(request);
    let url: string;
    try { url = new URL(request.path ?? '/', String(request.origin)).href; } catch { return; }
    // The allowlist and denylist apply here as everywhere: an excluded call is never tracked.
    if (runtime.excluded(url)) return;
    runtime.track(request.method ?? 'GET', () => url, response.statusCode, started.startedAt,
      performance.now() - started.started);
  };
  subscribe('undici:request:create', onCreate);
  subscribe('undici:request:headers', onHeaders);
  return () => {
    unsubscribe('undici:request:create', onCreate);
    unsubscribe('undici:request:headers', onHeaders);
  };
}
