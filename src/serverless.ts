/**
 * Serverless platforms freeze a function once its response is sent. A timer
 * set then never fires and `beforeExit` never runs, so anything the SDK means
 * to send later is lost. Two answers, used together: send at once instead of
 * later, and hand the send to the platform so it waits before freezing.
 */

type Env = Record<string, string | undefined>;
type WaitUntil = (promise: Promise<unknown>) => void;

/** Vercel's request context first, then Next.js's own (`next start`, other hosts). */
const CONTEXTS = [Symbol.for('@vercel/request-context'), Symbol.for('@next/request-context')];

/** Vercel, AWS Lambda (Netlify Functions run on it) and Cloud Run each set one of these at runtime. */
export function isServerless(env: Env = process.env): boolean {
  return Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.K_SERVICE);
}

/**
 * Ask the platform to keep the function alive until `promise` settles. The
 * same lookup `@vercel/functions` does, without the dependency. A no-op outside
 * a request, or where no platform offers it; never throws.
 */
export function keepAlive(promise: Promise<unknown>): void {
  try {
    const globals = globalThis as unknown as Record<symbol, { get?: () => { waitUntil?: WaitUntil } | undefined } | undefined>;
    for (const symbol of CONTEXTS) {
      const waitUntil = globals[symbol]?.get?.()?.waitUntil;
      if (typeof waitUntil === 'function') {
        waitUntil(promise.catch(() => {}));
        return;
      }
    }
  } catch { /* the platform's context is never allowed to fail the caller */ }
}
