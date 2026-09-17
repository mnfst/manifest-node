---
'manifest': patch
---

Retry a DELETE or OPTIONS bodyless when the patch merges to no body, instead of skipping the retry. GET and HEAD still never carry a body.
