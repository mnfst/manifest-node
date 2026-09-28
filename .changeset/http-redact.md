---
"manifest": minor
---

Credential values are now masked by `@mnfst/http-redact` before anything is sent: `Authorization`, API keys, OAuth values and passwords wherever they sit, including nested body fields and secrets in URL paths. Cookies are never sent. The retry puts the real values back, and never sends `REDACTED` to your API.
