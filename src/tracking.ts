import type { TrackedCall } from './types.js';

const MAX_BUFFER = 5000;
const MAX_BATCH = 500;

type Send = (batch: TrackedCall[]) => Promise<void>;
interface Options { intervalMs?: number; flushAt?: number; minGapMs?: number }

/**
 * Collects one metadata record per outbound call and ships them to
 * `POST /v1/requests` in batches, never on the caller's path: `record()` is an
 * in-memory append and nothing else.
 *
 * Bounded: past MAX_BUFFER the newest call is dropped, so a burst can never
 * grow memory. One send in flight, at most one per `minGapMs`. A batch whose
 * send throws is retried once, then dropped. The interval timer is unref'd, so
 * an idle buffer never keeps a process alive.
 */
export class CallBuffer {
  private queue: TrackedCall[] = [];
  private inFlight: Promise<void> | null = null;
  private lastSentAt = -Infinity;
  private readonly timer: NodeJS.Timeout;
  private readonly flushAt: number;
  private readonly minGapMs: number;

  constructor(private readonly send: Send, options: Options = {}) {
    this.flushAt = options.flushAt ?? 500;
    this.minGapMs = options.minGapMs ?? 1000;
    this.timer = setInterval(() => void this.kick(), options.intervalMs ?? 5000);
    this.timer.unref();
  }

  record(call: TrackedCall): void {
    if (this.queue.length >= MAX_BUFFER) return;
    this.queue.push(call);
    if (this.queue.length >= this.flushAt) void this.kick();
  }

  size(): number { return this.queue.length; }

  /** Resolves when the send in flight, if any, has settled. */
  async idle(): Promise<void> { await this.inFlight; }

  /** Drain everything now (exit path), still honouring the gap between sends. */
  async flush(): Promise<void> {
    await this.inFlight;
    while (this.queue.length > 0) await this.sendOne();
  }

  stop(): void { clearInterval(this.timer); }

  private kick(): Promise<void> {
    if (this.inFlight || this.queue.length === 0) return this.inFlight ?? Promise.resolve();
    // Too soon after the last send: the timer, or the next record() past
    // flushAt, sends it instead.
    if (performance.now() - this.lastSentAt < this.minGapMs) return Promise.resolve();
    this.inFlight = this.sendOne().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async sendOne(): Promise<void> {
    const batch = this.queue.splice(0, MAX_BATCH);
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.waitForGap();
      this.lastSentAt = performance.now();
      try { await this.send(batch); return; } catch { /* retry once, then drop */ }
    }
  }

  // Referenced on purpose: this wait only happens while a send or an exit
  // flush is under way, and an unref'd wait would let the process exit with
  // the batch unsent. It lasts at most minGapMs.
  private async waitForGap(): Promise<void> {
    const wait = this.lastSentAt + this.minGapMs - performance.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  }
}
