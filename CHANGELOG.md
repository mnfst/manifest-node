# manifest

## 7.1.0

### Minor Changes

- 166988b: Add `npx manifest doctor`. It resolves the installed version, masks and validates `MNFST_KEY` in one round trip to the handshake endpoint, checks that Manifest loads before your app, and prints the runtime coverage. The package now ships a `manifest` bin.

### Patch Changes

- ee3722e: Retry a DELETE or OPTIONS bodyless when the patch merges to no body, instead of skipping the retry. GET and HEAD still never carry a body.
- ceb0304: Stop sending the `x-mnfst-source` header. `User-Agent` carries the SDK name and version, which is what the app reads.
- 26af0bd: Lead the install with `manifest()` in the entry file instead of the `node -r manifest/register` preload. The preload still exists and is still the right answer where a client is built at import time or the start command is not yours to change, but it is no longer the first thing an install has to do. `doctor`'s "Preload active" check becomes "Loads before your app": an install it cannot see is now a warning rather than a failure, so a correct in-code install no longer exits non-zero.

## 7.0.0

### Major Changes

- 507a2ba: Remove the `flush()` export. Outcome reports are already asynchronous; the SDK no longer exposes a way to wait for queued reports. A long-running process delivers them normally.

### Minor Changes

- 1f64d75: Capture and retry form-urlencoded request bodies.
- a86de92: Add the `manifest/register` entry for `node --import`, which installs Manifest before the app's modules evaluate.
- ce11269: Capture any request-side 4xx instead of only 400, 404 and 422. Authentication (401, 403), billing (402), rate limits (429) and every 5xx still pass through untouched.
- 37fb4fa: Route default Axios and Node HTTP requests through Manifest healing.
