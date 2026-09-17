---
'manifest': patch
---

Stop sending the `x-mnfst-source` header. `User-Agent` carries the SDK name and version, which is what the app reads.
