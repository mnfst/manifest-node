import { installHttp } from "./http.js";
import { handled, installUndici } from "./undici.js";
import { Runtime } from "./runtime.js";
import { warn } from "./api.js";
import { resolveFilter } from "./filter.js";
import type { ManifestOptions } from "./types.js";
export type { ManifestOptions, HealEvent } from "./types.js";
export { VERSION } from "./api.js";
const STATE = Symbol.for("mnfst.node.runtime.v1");
const EXIT_FLUSH_MS = 2000;
const globals = globalThis as unknown as Record<symbol, Runtime | undefined>;

/** Install once, before libraries capture their own reference to global fetch. */
export function manifest(options: ManifestOptions = {}): void {
  const key = options.key || process.env.MNFST_KEY;
  if (!key) {
    warn("MNFST_KEY is not set; Manifest is disabled");
    return;
  }
  const url = baseUrl(options.url || process.env.MNFST_URL || "https://api.manifest.build");
  // A bad URL disables Manifest, like a missing key: installing must never stop the app.
  if (!url) {
    warn(
      "Manifest URL must be an HTTP(S) base URL without credentials, query or fragment; Manifest is disabled"
    );
    return;
  }
  const { filter, invalid } = resolveFilter(options, process.env);
  if (invalid.length > 0) warn(`Ignoring unreadable allowlist/denylist entries: ${invalid.join(", ")}`);
  const resolved = { ...options, key, url: url.toString(), filter };
  const existing = globals[STATE];
  if (existing) {
    if (
      existing.options.key !== key ||
      existing.options.url !== resolved.url ||
      existing.options.onHeal !== options.onHeal ||
      JSON.stringify(existing.options.filter) !== JSON.stringify(filter)
    ) {
      warn(
        "Manifest is already configured; changing configuration requires a process restart"
      );
    }
    return;
  }
  const runtime = new Runtime(resolved, globalThis.fetch.bind(globalThis));
  globalThis.fetch = runtime.fetch;
  installHttp(runtime);
  installUndici(runtime);
  globals[STATE] = runtime;
  // Announce the install, so that silence stops being ambiguous. Fire-and-
  // forget: it must never delay startup and never throw into the host app.
  // Handled, so a fetch that runs on node:http never tracks the handshake.
  try {
    handled(() => runtime.api.hello(`node-${process.versions.node}`));
  } catch { /* a fetch that throws synchronously must not reach the app either */ }
  // Send the calls still buffered when the event loop drains (a script or a
  // cron job ending). The app owns its signals, so no SIGTERM handler here.
  // Once, with a deadline: a script must never hang on an unreachable server.
  process.once("beforeExit", () => {
    if (runtime.tracker.size() > 0) void runtime.tracker.flush(EXIT_FLUSH_MS);
  });
}

function baseUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
