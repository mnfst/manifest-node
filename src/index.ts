import { Runtime } from './runtime.js';
import { warn } from './api.js';
import type { ManifestOptions } from './types.js';
export type { ManifestOptions, HealEvent } from './types.js';
export { VERSION } from './api.js';
const STATE = Symbol.for('mnfst.node.runtime.v1');
const globals = globalThis as unknown as Record<symbol, Runtime | undefined>;

/** Install once, before libraries capture their own reference to global fetch. */
export function manifest(options: ManifestOptions = {}): void {
  const key = options.key || process.env.MNFST_KEY;
  if (!key) { warn('MNFST_KEY is not set; Manifest is disabled'); return; }
  const url = new URL(options.url || process.env.MNFST_URL || 'https://api.manifest.build');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Manifest URL must be an HTTP(S) base URL without credentials, query or fragment');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  const resolved = { ...options, key, url: url.toString() };
  const existing = globals[STATE];
  if (existing) {
    if (existing.options.key !== key || existing.options.url !== resolved.url || existing.options.onHeal !== options.onHeal) {
      warn('Manifest is already configured; changing configuration requires a process restart');
    }
    return;
  }
  const runtime = new Runtime(resolved, globalThis.fetch.bind(globalThis));
  globalThis.fetch = runtime.fetch;
  globals[STATE] = runtime;
}

/** Wait for queued outcome reports within one total deadline. Does not uninstall. */
export async function flush(options: { timeoutMs?: number } = {}): Promise<void> {
  await globals[STATE]?.api.flush(options.timeoutMs ?? 5000);
}
