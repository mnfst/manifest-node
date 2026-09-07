import { manifest, flush, type HealEvent } from '@mnfst/node';
const onHeal = (event: HealEvent): void => { void event.replayStatusCode; };
// Compile-only coverage for the published ESM declaration entry.
const initialize: () => void = () => manifest({ key: 'example', onHeal });
const finish: () => Promise<void> = () => flush({ timeoutMs: 1000 });
void initialize; void finish;
