# SDK guide

[← Quick start](../README.md)

## Configuration

Call `manifest()` once at startup, before other libraries save a reference to `fetch`, `node:http` or `node:https`.

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

## Verifying the installation

Send a JSON request that your test API rejects with 400, 404, 422 or any other request-side 4xx. The failure appears in your project's dashboard, and the `onHeal` callback reports the repair result. A successful request alone does not contact Manifest. Outcome reports are asynchronous, so a short-lived script may exit before the report is delivered.

## Supported traffic

- Built-in global `fetch`, including `Request` inputs and libraries that call global fetch after installation.
- `node:http` and `node:https`, including Axios with its default HTTP adapter.
- Failures after automatic redirects pass through: the original method/body may not describe the failing hop.
- Captures any 4xx except 401, 402, 403 and 429. Those four, every 5xx, and network failures before an HTTP response pass through: authentication, billing, rate limiting and server faults are not things editing the request can fix.
- JSON and `application/x-www-form-urlencoded` APIs, including nested form fields. No provider-specific request format is required.
- One retry per capture. Same-origin URL and header repairs are supported by the SDK; the current app returns structured body repairs.
- Successful calls and successful retries remain streamed. Failed responses retain their bytes, status, headers, URL and redirect metadata.

**Not covered:** browser JavaScript, HTTP/2, directly imported `undici.fetch`/`node-fetch`, and transport references saved before initialization. Those transports need separate integration. This SDK does not claim to intercept every Node HTTP client.

## Limits and failure behavior

- Request capture is bounded to 256 KiB and structure depth 64. Fetch uploads are teed for at most one second; Node HTTP writes are copied as they are sent. Oversized, malformed or slow fetch uploads travel as `null` and are not retried.
- Form-urlencoded retries are re-encoded from the parsed structure, so repeated keys such as `expand=a&expand=b` return as `expand[0]=a&expand[1]=b`. Servers that reject indexed keys see the retry fail like any other unsuccessful repair.
- Error capture reads at most 64 KiB plus one transport chunk, within one second. The prefix and remaining stream are preserved for the caller. Incomplete errors are reported without retry. One unusually large transport chunk can exceed that memory estimate.
- The Manifest heal call has a 60-second deadline and at most eight concurrent requests. Capacity exhaustion and service errors return the original API error response.
- Caller abort signals apply during healing and retry; cancellation remains observable to the caller.
- A transport failure on retry returns the original error response and reports inconclusive evidence. If the retry returns another HTTP error, its raw body is reported so the app can distinguish recurrence from a new issue.
- Automatic retries can repeat side effects. Use APIs with safe retry semantics and caller-managed idempotency keys; these headers are preserved unless explicitly changed by a repair.
- A disabled project's HTTP 403 response suppresses healing for five minutes.

Outcome reports are best effort, limited to 64 concurrent requests with five-second deadlines. Failures and drops emit Node warnings with code `MNFST`. Reports are asynchronous: a long-running process delivers them normally, while a short-lived script may exit before delivery. Abrupt termination can lose reports.

## Data sent to Manifest

Failed URLs, request headers, JSON or form-urlencoded bodies, and raw error responses go to the configured server. Known credential names in query parameters and headers are masked; credential-named top-level request body fields are withheld and restored on retry. Exception prose is not sent for transport failures.

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
