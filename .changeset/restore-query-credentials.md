---
'manifest': patch
---

Put the caller's own query credentials back on a healed URL: the SDK masks them on the wire and the server never serves them, so a retry of a `?key=` authenticated request used to go out without its key. A header the server echoes under the SDK's mask is left as the caller sent it.
