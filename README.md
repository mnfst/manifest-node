<div align="center">

![Manifest SDK Architecture](https://raw.githubusercontent.com/mnfst/manifest-node/main/docs/github-sdk.png)

# Manifest for Node.js

**See every API call your app makes. Heal the ones that fail.**

[![CI](https://github.com/mnfst/manifest-node/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mnfst/manifest-node/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/manifest?label=npm)](https://www.npmjs.com/package/manifest)
[![npm downloads](https://img.shields.io/npm/dm/manifest?label=npm%20downloads)](https://www.npmjs.com/package/manifest)

</div>

---

## What is Manifest

Manifest watches every API call your app makes and heals the ones that fail, in real time.

* ⏰ **Know what will break next**: Manifest warns you when an API you call is about to change or retire a model, before your calls start failing.
* 🎯 **Heal failures on the fly**: Manifest patches a failed request and sends it again before your users notice.
* 📡 **See all your traffic live**: every call, its status and latency, and the issues behind each failure, provider by provider.

Works with internal APIs, external services and agent tools.

## How it works

![How the SDK works: every call Manifest does not heal is recorded in the background as metadata (method, URL, status, timing, no body); a failure Manifest can heal is sent with its error, patched, and retried once, returning a 200 OK](./docs/sdk-flow-diagram.png)

Every call your app makes is reported to Manifest as metadata only (method, URL without its query string, status and timing), in the background. A failure Manifest can heal is sent in full, so it can be repaired. [What is sent](docs/guide.md#data-sent-to-manifest).

## Prerequisites

- <a href="https://nodejs.org/en/download/" target="_blank">Node.js 22</a> or higher

## Get started

### Start with your agent

```
"Install Manifest in this app: https://dashboard.manifest.build/prompt-node.md"
```

[Read the prompt →](https://dashboard.manifest.build/prompt-node.md)

The prompt adds the one-line install to your entry file and stops to let you paste your key.

### Start with code

```sh
npm install manifest
```

```js
import { manifest } from 'manifest';

manifest();  // Once, at startup.
// Keep making your API calls as usual.
```

TypeScript, ESM and CommonJS. Zero dependencies.

## Setup

1. Create a project in your [Manifest dashboard](https://dashboard.manifest.build) and copy its project key.
2. Set the key as an environment variable:

```sh
export MNFST_KEY='your-project-key'
```

Call `manifest()` from the first import of the file that starts your app, before any client is constructed. Some clients keep the `fetch` they saw when they were built, and a client built at import time runs before your call. Where that happens, or where the start command is not yours to change, preload the SDK instead:

```sh
node -r manifest/register app.js
```

Self-healing is enabled by default in your project settings.

Verify the install from your project directory:

```sh
npx manifest doctor
```

It resolves the installed SDK version, masks and validates the key against the handshake endpoint, checks that Manifest loads before your app, and prints the runtime coverage.

## Try it

Send a request that would normally fail. Manifest catches it, repairs it, and retries:

```js
import { manifest } from 'manifest';

manifest({
  onHeal(event) {
    console.log('[manifest]', event.healStatus, event.replayStatusCode);
  },
});

const res = await fetch('https://api.example.com/orders', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ limit: 500 }),  // Invalid? Manifest fixes it and retries.
});
console.log(res.status);  // See the 200 OK response.
```

Check your [Manifest dashboard](https://dashboard.manifest.build) to see all repairs and insights.

## More

[Configuration, limits & development](docs/guide.md) · [API contract](CONTRACT.md) · [Python SDK](https://github.com/mnfst/manifest-python) · [Website](https://manifest.build)
