---
"manifest": patch
---

A `node:http` call is healed only when a `fetch` retry reaches the same server the same way: a `Host` header naming another server, a proxy agent, TLS or socket options keep it tracked instead. A method `fetch` refuses gets its original response back. The SDK no longer tracks its own calls when `fetch` runs on `node:http`, a patched retry is filtered by the allowlist and denylist, encoded paths are matched decoded, and an invalid `MNFST_URL` disables Manifest with a warning instead of throwing.
