---
"manifest": minor
---

Track every call as metadata. Calls that are not healed, whatever their status, are now sent in batches to `POST /v1/requests`: method, URL without the query string, status code, response time and time of the call. No headers and no bodies. Recording is an in-memory append that never slows the call; batches go out at most once per second and are flushed when the process ends. Healable failures still go to `/v1/heal` and are not tracked twice.
