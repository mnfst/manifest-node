# SDK / app contract

The SDK talks to the configured Manifest API using `Authorization: Bearer <project key>` and `User-Agent: mnfst-node/<version>`.

## Handshake

`POST /v1/hello` announces an install — `{"runtime":"node-22.0.0"}` — authorized with the same bearer key. A `200` confirms the key; `401`, or a `403` whose body is not `{"error":"project_disabled"}`, rejects it. The `200` body may carry project and activity context, all optional:

```json
{"project": {"name": "Find Concierge"}, "requests": 12}
```

`manifest doctor` reads `project` (also accepting `projectName`, `project_name` or a bare `name`) and `requests` (also accepting `requestCount`, `requestsCount`, `requests_count`, `request_count`, or an object with `total`) to print the project and to warn when no request has arrived yet. Missing fields simply hide those lines.

A capture may carry a top-level `"synthetic": true`, which `manifest doctor --send-test` sets. Synthetic captures exist only to prove the pipeline end to end and must be excluded from statistics.

## Capture

`POST /v1/heal` receives:

```json
{
  "traceId": "unique-capture-id",
  "request": {"method": "POST", "url": "https://example.com/orders", "headers": {}, "body": {"limit": 200}},
  "response": {"statusCode": 400, "body": {"error": "limit must be at most 100"}, "truncated": false},
  "responseTimeMs": 25
}
```

Any 4xx response is captured except 401, 402, 403 and 429; those and every 5xx pass through untouched, because auth, billing, rate limiting and server faults are not repaired by editing the request. JSON bodies and `application/x-www-form-urlencoded` bodies are sent as structured JSON values. Credential filtering and body limits are described in the README. Capture gates live in `runtime.ts`; the server owns repair policy.

A successful heal response may contain `status: patched|unverified`, `healAttemptId`, `operations` and `healedRequest` with `url`, `headers` or `body`. Only these two statuses authorize a retry. No patch, malformed responses and unavailable service return the original error response. HTTP 403 with `{"error":"project_disabled"}` suppresses healing for five minutes.

## Apply

A healed URL replaces the URL only within the original origin. Headers set or replace case-insensitively; null removes a header. Content length is recalculated. Objects merge using the server's healed body as the authoritative copy of fields sent to the server; withheld local credential fields are restored. Non-object JSON replaces the body. Form-urlencoded retries use the original encoding and are re-encoded from the parsed structure, so repeated keys return as indexed keys; a non-object healed body is not retried for them. A healed body that merges to nothing is sent as no body at all: GET, HEAD, DELETE and OPTIONS retry bodyless, and any other method is not retried. GET and HEAD never carry a body on a retry. Incomplete or malformed request captures and incomplete error captures are not retried.

Each captured failure permits one retry. A retry response, including another failure, is returned to the caller. A transport failure returns the original response. Successful response streams are not eagerly consumed.

## Outcome

`PATCH /v1/heal-attempts/:id` sends exactly one of:

```json
{"response":{"statusCode":200}}
```

```json
{"response":{"statusCode":400,"body":{"error":"raw upstream error"},"truncated":false}}
```

```json
{"failure":{"kind":"transport_error","message":"Upstream retry failed before an HTTP response"}}
```

```json
{"failure":{"kind":"not_attempted","message":"replay_not_attempted"}}
```

HTTP status must be 200–599. Transport failures use a fixed message without exception prose. HTTP status zero is not a wire status. Transport failures and unattempted retries are inconclusive evidence; neither can verify or invalidate a patch. The server determines the verdict from the raw evidence, with the first accepted report winning.

Reports are best effort, bounded, and observable through Node warnings with code `MNFST`. The SDK sends the failed retry's raw body so the app can distinguish recurrence from a newly revealed issue. It does not assert `succeeded` or `failed` itself.

## Tracked requests

Every call the SDK sees and does not send to `POST /v1/heal`, whatever its status (2xx, 3xx, 401, 402, 403, 429, 5xx, and a 4xx after a redirect or while the project is disabled), is recorded and sent in batches to `POST /v1/requests`:

```json
{"requests":[{"traceId":"a-uuid","method":"POST","url":"https://example.com/orders","statusCode":200,"responseTimeMs":84,"occurredAt":"2026-09-23T10:14:07.512Z"}]}
```

Metadata only. The URL carries scheme, host, port and path: no query string, userinfo or fragment. No headers and no request or response body are sent, and a response body is never read to record a call. A call sent to `/v1/heal` is not also tracked.

Recording is an in-memory append and never delays or fails the caller's request. A batch is sent when 500 calls are queued or every five seconds, at most once per second, one send at a time, up to 500 calls per request, with a five-second deadline. At most 5,000 calls are buffered; newer calls are dropped past that. A network error, timeout, 429 or 5xx is retried once, then the batch is dropped; any other answer, including 404 from a server without the route, drops it. HTTP 403 with `{"error":"project_disabled"}` suspends sending for five minutes, as for healing. Buffered calls are sent when the event loop drains (`beforeExit`); a process killed or frozen first (serverless) can lose them.
