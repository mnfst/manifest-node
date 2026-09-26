# SDK guide

[← Quick start](../README.md)

## Configuration

Call `manifest()` once at startup, before other libraries save a reference to `fetch`, `node:http` or `node:https`. Where a client is built at import time and would capture the original `fetch` first, [preload the register entry](#preloading) instead.

It reads `MNFST_KEY` and `MNFST_URL` and takes no options.

| Option | Environment | Default |
| --- | --- | --- |
| `key` | `MNFST_KEY` | Disabled with a warning if missing |
| `url` | `MNFST_URL` | `https://api.manifest.build` |
| `onHeal` | — | Optional local callback |

Explicit options take precedence. Reconfiguration requires a restart. ESM and CommonJS imports share one process-wide installation; CommonJS uses `const { manifest } = require('manifest')`.

To target a local Manifest app instead of `https://api.manifest.build`, set `MNFST_URL` (for example `http://127.0.0.1:5310`). The app must already be running and support the [SDK API contract](../CONTRACT.md).

```ts
manifest({
  url: 'http://127.0.0.1:5310',
  onHeal(event) {
    console.log(event.healStatus, event.replayStatusCode);
  },
});
```

`onHeal` receives `url`, `statusCode`, `healStatus`, `replayStatusCode`, `healMs` and optional `operations`. URLs have known credential query fields masked. Callback errors do not fail application requests.

## Preloading

Calling `manifest()` from the first import of your entry file covers clients that read `fetch` after it runs, which is most of them. Some clients, the OpenAI and Anthropic SDKs among them, read global `fetch` once when constructed, and a client built at import time runs before any `manifest()` call in your code. Preload the register entry to install first:

```sh
node -r manifest/register app.js
```

`-r` is CommonJS `require`; `--import manifest/register` is the ESM loader form. Both resolve the same entry and install before the app module evaluates, in CJS and ESM apps alike. Prefer `-r` where you launch the process: it takes no quoting and works on Windows.

For a process you do not launch yourself — a framework CLI such as `nest start`, or a host dashboard that owns the command — pass it through `NODE_OPTIONS`:

```sh
NODE_OPTIONS="--require manifest/register" nest start
```

The register entry reads `MNFST_KEY` **once, at load**. Setting or changing the key without restarting the process does nothing. Without a key it warns once, leaves `fetch`, `node:http` and `node:https` untouched, and the app runs to exit 0.

### Next.js

Serverless deployments such as Vercel have no start command, so neither preload flag applies. Install from `instrumentation.ts`:

```ts
// src/instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { manifest } = await import('manifest');
    manifest();
  }
}
```

Guard inside an `if` block, as above, rather than returning early, and import `manifest` dynamically. A top-level import is resolved for both runtimes, and the Edge build fails with `Can't resolve 'http'`. On Next.js 14, set `experimental.instrumentationHook: true` in `next.config.js`.

### Edge runtime

Not supported. The SDK needs `node:crypto`, `node:http` and `node:https`, none of which exist on Edge. Next.js `middleware.ts` always runs on Edge and is therefore never covered.

## Verifying the installation

Run the doctor from the project directory. It checks the install without guessing from source:

```sh
npx manifest doctor
```

```
  ✅ SDK installed          manifest 7.0.0
  ✅ MNFST_KEY set          mnfst_proj_…DZDw
  ✅ Key valid              project "Find Concierge"
  ⚠️ Loads before your app  cannot tell from here whether manifest() runs; check
                            Requests received
  ⚠️ Requests received      no requests received yet

Runtime coverage
  Node.js runtime   fetch, http.request, https.request, http.get are patched
  Edge runtime      not supported — middleware.ts and Edge route handlers are never covered
```

**Loads before your app** recognizes a preload flag in a script and `instrumentation.ts` on a Next.js project. It does not read your source, so the ordinary `manifest()` call in an entry file is invisible to it: that is a warning, not a failure, and **Requests received** is what settles it. The one failure it reports is a Next.js project with no instrumentation file, where nothing can install Manifest at all.

`doctor` resolves the installed version, masks the key (it is never printed in full), and makes one round trip to the handshake endpoint — the only check that tells a good key from a typo'd or revoked one, which both look like silence otherwise. A non-zero exit code means a check failed.

The key check is a probe: it proves the key works without registering an install, so a diagnostic run never makes the dashboard claim your app is connected. Only a real boot does that.

You can also verify by hand: send a JSON request that your test API rejects with 400, 404, 422 or any other request-side 4xx. The failure appears in your project's dashboard, and the `onHeal` callback reports the repair result. A successful request alone does not contact Manifest. Outcome reports are asynchronous, so a short-lived script may exit before the report is delivered.

## Supported traffic

- Built-in global `fetch`, including `Request` inputs and libraries that call global fetch after installation.
- `node:http` and `node:https`, including Axios with its default HTTP adapter and `node-fetch`.
- Failures after automatic redirects pass through: the original method/body may not describe the failing hop.
- Captures any 4xx except 401, 402, 403 and 429. Those four, every 5xx, and network failures before an HTTP response pass through: authentication, billing, rate limiting and server faults are not things editing the request can fix.
- JSON and `application/x-www-form-urlencoded` APIs, including nested form fields. No provider-specific request format is required.
- One retry per capture. Same-origin URL and header repairs are supported by the SDK; the current app returns structured body repairs.
- Successful calls and successful retries remain streamed. Failed responses retain their bytes, status, headers, URL and redirect metadata.
- Every call that is not healed, whatever its status, is tracked as metadata only and sent in batches, off the request path (see "Data sent to Manifest").

**Not covered:** browser JavaScript, HTTP/2, directly imported `undici.fetch`, and `fetch` references saved before initialization (see `manifest/register` above). Those transports need separate integration. This SDK does not claim to intercept every Node HTTP client.

## Limits and failure behavior

- Request capture is bounded to 256 KiB and structure depth 64. Fetch uploads are teed for at most one second; Node HTTP writes are copied as they are sent. Oversized, malformed or slow fetch uploads travel as `null` and are not retried.
- Form-urlencoded retries are re-encoded from the parsed structure, so repeated keys such as `expand=a&expand=b` return as `expand[0]=a&expand[1]=b`. Servers that reject indexed keys see the retry fail like any other unsuccessful repair.
- Error capture reads at most 64 KiB plus one transport chunk, within one second. The prefix and remaining stream are preserved for the caller. Incomplete errors are reported without retry. One unusually large transport chunk can exceed that memory estimate.
- The Manifest heal call has a 60-second deadline and at most eight concurrent requests. Capacity exhaustion and service errors return the original API error response. If the configured server is unreachable, the heal attempt fails in about 10 ms and the app's original error response surfaces unchanged.
- Caller abort signals apply during healing and retry; cancellation remains observable to the caller.
- A transport failure on retry returns the original error response and reports inconclusive evidence. If the retry returns another HTTP error, its raw body is reported so the app can distinguish recurrence from a new issue.
- Automatic retries can repeat side effects. Use APIs with safe retry semantics and caller-managed idempotency keys; these headers are preserved unless explicitly changed by a repair.
- A disabled project's HTTP 403 response suppresses healing for five minutes.

Outcome reports are best effort, limited to 64 concurrent requests with five-second deadlines. Failures and drops emit Node warnings with code `MNFST`. Reports are asynchronous: a long-running process delivers them normally, while a short-lived script may exit before delivery. Abrupt termination can lose reports.

## Data sent to Manifest

**Every call (metadata only).** For each call that is not healed, whatever its status, the SDK sends its method, URL without the query string, userinfo or fragment, status code, response time and time of the call. No headers and no bodies. Calls are batched and sent in the background, at most once per second; recording one never slows the call. On Vercel, AWS Lambda and Cloud Run, each call is sent as soon as it is recorded, and the function is kept alive until it is delivered.

**Healable failures (full capture).** Failed URLs, request headers, JSON or form-urlencoded bodies, and raw error responses go to the configured server. Known credential names in query parameters and headers are masked; credential-named top-level request body fields are withheld and restored on retry. Exception prose is not sent for transport failures.

This is not general secret detection: nested fields, arbitrary secret names, business data and response bodies may contain sensitive information. Enable it only for traffic you permit Manifest to process and store. The SDK makes the actual retry locally.

## Development

```sh
npm ci
npm run typecheck
npm test
npm pack
# Optional: creates a synthetic customer and project on a disposable Manifest server.
MNFST_TEST_APP_URL=http://127.0.0.1:5310 npm run test:live
```

Add a changeset to each pull request that changes the published package:

```sh
npm run changeset
```

Select `patch` for compatible fixes, `minor` for compatible features, and `major` for breaking changes. Documentation and CI-only pull requests do not need a changeset. A merge to `main` updates a rolling release pull request. A merge of that release pull request publishes the committed version.

CI runs Node 22, 24 and 26, checks both declaration formats and installs the packed artifact. The `test:live` script runs locally, because CI has no access to a Manifest server.

See [CONTRACT.md](../CONTRACT.md) for the wire protocol that the Python SDK and the Node SDK share.
