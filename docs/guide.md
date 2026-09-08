# SDK guide

[← Quick start](../README.md)

## Configuration

Call `manifest()` once at startup, before other libraries save a reference to `fetch`.

| Option | Environment | Default |
| --- | --- | --- |
| `key` | `MNFST_KEY` | Disabled with a warning if missing |
| `url` | `MNFST_URL` | `https://api.manifest.build` |
| `onHeal` | — | Optional local callback |

Explicit options take precedence. Reconfiguration requires a restart. ESM and CommonJS imports share one process-wide installation.

```ts
manifest({
  url: 'http://127.0.0.1:5310',
  onHeal(event) {
    console.log(event.healStatus, event.replayStatusCode);
  },
});
```

`onHeal` receives `url`, `statusCode`, `healStatus`, `replayStatusCode`, `healMs` and optional `operations`. URLs have known credential query fields masked. Callback errors do not fail application requests.

## Supported traffic

- Built-in global `fetch`, including `Request` inputs and libraries that call global fetch after installation.
- Failures after automatic redirects pass through: the original method/body may not describe the failing hop.
- Captures HTTP 400, 404 and 422. Other statuses and network failures before an HTTP response pass through.
- Generic JSON APIs, including LLM APIs. No provider-specific request format is required.
- One retry per capture. Same-origin URL and header repairs are supported by the SDK; the current app returns JSON body repairs.
- Successful calls and successful retries remain streamed. Failed responses retain their bytes, status, headers, URL and redirect metadata.

**Not covered:** browser JavaScript, `node:http`/`node:https`, the default Axios HTTP adapter, directly imported `undici.fetch`/`node-fetch`, and fetch references saved before initialization. Those transports need separate integration. This SDK does not claim to intercept every Node HTTP client.

## Limits and failure behavior

- Request capture is bounded to 256 KiB and JSON depth 64. It tees the upload alongside the original call, reading for at most one second. Oversized or slow uploads travel as `null` and are not retried.
- Error capture reads at most 64 KiB plus one transport chunk, within one second. The prefix and remaining stream are preserved for the caller. Incomplete errors are reported without retry. One unusually large transport chunk can exceed that memory estimate.
- The Manifest heal call has a 60-second deadline and at most eight concurrent requests. Capacity exhaustion and service errors return the original API error response.
- Caller abort signals apply during healing and retry; cancellation remains observable to the caller.
- A transport failure on retry returns the original error response and reports inconclusive evidence. If the retry returns another HTTP error, its raw body is reported so the app can distinguish recurrence from a new issue.
- Automatic retries can repeat side effects. Use APIs with safe retry semantics and caller-managed idempotency keys; these headers are preserved unless explicitly changed by a repair.
- A disabled project's HTTP 403 response suppresses healing for five minutes.

Outcome reports are best effort, limited to 64 concurrent requests with five-second deadlines. Failures and drops emit Node warnings with code `MNFST`. Before a short-lived process exits, flush reports explicitly:

```ts
import { flush } from 'manifest';
await flush({ timeoutMs: 5000 });
```

`flush` waits within one total deadline; it does not uninstall the SDK or guarantee delivery. Abrupt termination can lose reports.

## Data sent to Manifest

Failed URLs, request headers, JSON bodies and raw error responses go to the configured server. Known credential names in query parameters and headers are masked; credential-named top-level request body fields are withheld and restored on retry. Exception prose is not sent for transport failures.

This is not general secret detection: nested fields, arbitrary secret names, business data and response bodies may contain sensitive information. Enable it only for traffic you permit Manifest to process and store. The SDK makes the actual retry locally.

## Development

```sh
npm ci
npm run typecheck
npm test
npm pack
# Optional: creates a synthetic customer/project in a disposable app.
MNFST_TEST_APP_URL=http://127.0.0.1:5310 npm run test:live
```

Add a changeset to each pull request that changes the published package:

```sh
npm run changeset
```

Select `patch` for compatible fixes, `minor` for compatible features, and `major` for breaking changes. Documentation and CI-only pull requests do not need a changeset. Merges to `main` update a rolling release pull request; merging that release pull request publishes the committed version.

CI runs Node 22, 24 and 26, checks both declaration formats, and installs the packed artifact. The live app test runs locally because cross-repository CI access to the private app is not configured.

Deploy the outcome contract in [app PR #3](https://github.com/mnfst/app/pull/3) before using this SDK. See [CONTRACT.md](../CONTRACT.md) for the shared Python/Node wire protocol.
