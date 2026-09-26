---
"manifest": minor
---

Track calls made through the `undici` package directly. Libraries such as `@vercel/blob` import `fetch` from `undici`, which goes through neither `globalThis.fetch` nor `node:http`, so their calls never reached Manifest. The SDK now watches undici's diagnostics channels, which Node's own `fetch` and the `undici` package both publish on, and tracks those calls as metadata. That also covers a `fetch` reference saved before `manifest()` ran. These calls are tracked, not healed: a channel can observe a response but not replace it. Calls already handled by the SDK's `fetch` and its own calls to Manifest are never counted twice.
