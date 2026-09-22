---
'manifest': patch
---

Lead the install with `manifest()` in the entry file instead of the `node -r manifest/register` preload. The preload still exists and is still the right answer where a client is built at import time or the start command is not yours to change, but it is no longer the first thing an install has to do. `doctor`'s "Preload active" check becomes "Loads before your app": an install it cannot see is now a warning rather than a failure, so a correct in-code install no longer exits non-zero.
