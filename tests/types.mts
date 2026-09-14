import { manifest, type HealEvent } from 'manifest';
const onHeal = (event: HealEvent): void => { void event.replayStatusCode; };
// Compile-only coverage for the published ESM declaration entry.
const initialize: () => void = () => manifest({ key: 'example', onHeal });
void initialize;
