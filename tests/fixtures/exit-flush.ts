// A script that makes one call and ends: its tracked call must still be sent.
import { manifest } from '../../src/index.js';
manifest({ key: 'project-key', url: process.env.MANIFEST_URL });
const response = await fetch(`${process.env.PROVIDER_URL}/ok`, { method: 'POST', body: '{}' });
await response.text();
