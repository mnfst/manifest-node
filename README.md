# Manifest for Node.js

[![CI](https://github.com/mnfst/manifest-node/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mnfst/manifest-node/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/manifest?label=npm)](https://www.npmjs.com/package/manifest)
[![npm downloads](https://img.shields.io/npm/dm/manifest?label=npm%20downloads)](https://www.npmjs.com/package/manifest)

Repair failed JSON and form-urlencoded API requests automatically. Works with built-in `fetch`, Node HTTP clients and Axios.

```js
import { manifest } from 'manifest';

manifest();
// Keep making your API calls as usual.
```

Your API rejects a request → Manifest finds a repair → the SDK retries once, locally.

## Setup

### 1. Install

Requires **Node.js 22+**:

```sh
npm install manifest
```

JavaScript, TypeScript, ESM and CommonJS are supported; there are no runtime dependencies.

### 2. Connect your project

Create a project in your Manifest dashboard and copy the project key shown during setup. In **Project Settings**, turn **Autofix** on to enable repairs.

```sh
export MNFST_KEY='your-project-key'
```

The SDK defaults to `https://api.manifest.build`. For a local app running on port 5310, also set:

```sh
export MNFST_URL='http://127.0.0.1:5310'
```

Your server must support the [SDK API contract](CONTRACT.md). The local app must already be running.

### 3. Initialize before your requests

Call `manifest()` once at startup, before other libraries save a reference to `fetch`, `node:http` or `node:https`. Save this as `example.mjs`, replacing the example endpoint and payload with your own:

```js
import { manifest, flush } from 'manifest';

manifest({
  onHeal(event) {
    console.log('[manifest]', event.healStatus, event.replayStatusCode);
  },
});

try {
  const response = await fetch('https://api.example.com/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 500 }),
  });
  console.log(response.status, await response.text());
} finally {
  await flush({ timeoutMs: 5000 });
}
```

Run it with `node example.mjs`. For an API that rejects `limit: 500` and has a matching repair, Manifest can retry with a valid limit. Repairs depend on the API error and available patches.

CommonJS uses `const { manifest, flush } = require('manifest')`.

## Check that it works

Send a JSON or `application/x-www-form-urlencoded` request that your test API rejects with **400, 404 or 422**. Check the failure in your project's dashboard and the `onHeal` callback for the repair result. A successful request alone does not contact Manifest. `flush()` lets a short script wait for outcome reports before exiting.

## What to expect

- **One retry.** Manifest returns a repair; the SDK sends the corrected request directly to your API.
- **Original error if healing is unavailable.** A heal call can add up to 60 seconds. If a retry returns an HTTP response, that response reaches your application.
- **Node HTTP clients.** Built-in `fetch`, `node:http`, `node:https` and default Axios requests are covered. Browser JavaScript and separately imported fetch implementations are not intercepted.
- **Retry semantics still matter.** Use idempotency keys where needed; a repeated request can repeat side effects.

## Privacy

Manifest receives failed request URLs, headers, JSON or form-urlencoded bodies, and error responses. Known credential fields are masked or withheld, but nested secrets, prompts and business data can still be sent. Enable it only for traffic you permit your Manifest server to process and store.

## More

[Configuration, limits & development](docs/guide.md) · [API contract](CONTRACT.md) · [Python SDK](https://github.com/mnfst/manifest-python)
