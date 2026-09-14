---
"manifest": minor
---

Capture any request-side 4xx instead of only 400, 404 and 422. Authentication (401, 403), billing (402), rate limits (429) and every 5xx still pass through untouched.
