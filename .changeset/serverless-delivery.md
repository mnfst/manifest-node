---
"manifest": minor
---

Deliver tracked calls and outcome reports on serverless platforms. Vercel, AWS Lambda and Cloud Run freeze a function once it responds, so the five-second interval and the exit flush never ran there and tracked calls were never sent. When `VERCEL`, `AWS_LAMBDA_FUNCTION_NAME` or `K_SERVICE` is set, each call is now sent as soon as it is recorded, and that send and every outcome report are handed to the platform's `waitUntil` (Vercel's or Next.js's request context), so the function waits for them before freezing. Long-running servers are unchanged.
