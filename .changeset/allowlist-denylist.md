---
"manifest": minor
---

Keep chosen calls out of Manifest entirely with `MNFST_ALLOWLIST` / `MNFST_DENYLIST` (or the `allowlist` / `denylist` options). An entry is a domain (`stripe.com`, subdomains included) or a domain with a path (`stripe.com/v1/charges`, whole segments); the denylist wins.
