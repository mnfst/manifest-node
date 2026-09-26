// One serverless invocation: the platform's request context collects what the
// SDK hands to waitUntil, the handler makes one call and returns, then the
// platform awaits those promises and freezes the process. process.exit()
// stands in for the freeze: no interval tick and no beforeExit ever runs.
const pending: Promise<unknown>[] = [];
(globalThis as Record<symbol, unknown>)[Symbol.for(process.env.CONTEXT_SYMBOL ?? '@vercel/request-context')] = {
  get: () => ({ waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } }),
};
const { manifest } = await import('../../src/index.js');
manifest({ key: 'project-key', url: process.env.MANIFEST_URL });
await (await fetch(`${process.env.PROVIDER_URL}${process.env.CALL_PATH ?? '/ok'}`,
  { method: 'POST', body: process.env.CALL_BODY ?? '{}' })).text();
await Promise.allSettled(pending);
process.exit(0);
