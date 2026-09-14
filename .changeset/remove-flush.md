---
"manifest": major
---

Remove the `flush()` export. Outcome reports are already asynchronous; the SDK no longer exposes a way to wait for queued reports. A long-running process delivers them normally.
