<div align="center">

![Manifest SDK Architecture](./docs/github-sdk.png)

# Manifest for Node.js

**Turn 🔴 4xx API errors into 🟢 2xx in real time.**

[![CI](https://github.com/mnfst/manifest-node/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mnfst/manifest-node/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/manifest?label=npm)](https://www.npmjs.com/package/manifest)
[![npm downloads](https://img.shields.io/npm/dm/manifest?label=npm%20downloads)](https://www.npmjs.com/package/manifest)

</div>

---

## What is Manifest

Manifest is a self-healing layer that fixes and retries failed API requests on the fly.

* 🎯 **Fix failures automatically** before they impact your users.
* 🔔 **Get notified of root causes** so you can fix them permanently.
* 🔌 **Works across your stack** with internal APIs, external services, and agent tools.

## How it works

![How Manifest heals a failed request: a 400 reaches Manifest, drops to a patch from the knowledge base or the healing agents, and is retried once, returning a 200 OK](./docs/sdk-flow-diagram.png)

## Prerequisites

- <a href="https://nodejs.org/en/download/" target="_blank">Node.js 22</a> or higher

## Get started

### Start with your agent

```
"Install Manifest in this app: https://app-staging.manifest.build/prompt-node.md"
```

[Read the prompt →](https://app-staging.manifest.build/prompt-node.md)

The prompt adds the preload to your start command and stops to let you paste your key.

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

Call `manifest()` before any library grabs its own reference to `fetch` or `node:http`. To install before any of your modules run, preload it instead:

```sh
node -r manifest/register app.js
```

Self-healing is enabled by default in your project settings.

Verify the install from your project directory:

```sh
npx manifest doctor
```

It resolves the installed SDK version, masks and validates the key against the handshake endpoint, checks that Manifest loads before your app, and prints the runtime coverage. Add `--send-test` to send one synthetic failing request and flip the dashboard's connect screen right away.

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
