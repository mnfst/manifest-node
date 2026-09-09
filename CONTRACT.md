# SDK / app contract

The SDK talks to the configured Manifest API using `Authorization: Bearer <project key>` and `User-Agent: mnfst-node/<version>`.

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

JSON bodies and `application/x-www-form-urlencoded` bodies are sent as structured JSON values. Credential filtering and body limits are described in the README. Capture gates live in `runtime.ts`; the server owns repair policy.

A successful heal response may contain `status: patched|unverified`, `healAttemptId`, `operations` and `healedRequest` with `url`, `headers` or `body`. Only these two statuses authorize a retry. No patch, malformed responses and unavailable service return the original error response. HTTP 403 with `{"error":"project_disabled"}` suppresses healing for five minutes.

## Apply

A healed URL replaces the URL only within the original origin. Headers set or replace case-insensitively; null removes a header. Content length is recalculated. Objects merge using the server's healed body as the authoritative copy of fields sent to the server; withheld local credential fields are restored. Non-object JSON replaces the body. Form-urlencoded retries use the original encoding and are re-encoded from the parsed structure, so repeated keys return as indexed keys; a non-object healed body is not retried for them. Incomplete or malformed request captures and incomplete error captures are not retried.

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
