// A script installed through manifest() that makes calls and ends: its
// tracked calls must still be sent, and the SDK's own sends never tracked.
import { manifest } from '../../src/index.js';
manifest({ key: 'project-key', url: process.env.MANIFEST_URL });
const call = async () => (await fetch(`${process.env.PROVIDER_URL}/ok`, { method: 'POST', body: '{}' })).text();
await call();
// Let the interval send the first call, so a self-tracked send would show up.
if (process.env.WAIT_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.WAIT_MS)));
await call();
