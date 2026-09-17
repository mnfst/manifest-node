---
'manifest': minor
---

Add `npx manifest doctor`. It resolves the installed version, masks and validates `MNFST_KEY` in one round trip to the handshake endpoint, checks that Manifest loads before your app, and prints the runtime coverage. `--send-test` sends one synthetic failing capture so the dashboard's connect screen flips immediately. The package now ships a `manifest` bin.
