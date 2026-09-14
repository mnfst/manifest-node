# manifest

## 7.0.0

### Major Changes

- 507a2ba: Remove the `flush()` export. Outcome reports are already asynchronous; the SDK no longer exposes a way to wait for queued reports. A long-running process delivers them normally.

### Minor Changes

- 1f64d75: Capture and retry form-urlencoded request bodies.
- a86de92: Add the `manifest/register` entry for `node --import`, which installs Manifest before the app's modules evaluate.
- ce11269: Capture any request-side 4xx instead of only 400, 404 and 422. Authentication (401, 403), billing (402), rate limits (429) and every 5xx still pass through untouched.
- 37fb4fa: Route default Axios and Node HTTP requests through Manifest healing.
