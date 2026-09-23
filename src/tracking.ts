import type { TrackedCall } from './types.js';

const MAX_BUFFER = 5000;
const MAX_BATCH = 500;

type Send = (batch: TrackedCall[], signal: AbortSignal) => Promise<void>;
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
  /** Past this instant, nothing is retried or waited for, and a send in flight is aborted. */
  private deadline = Infinity;
  private controller = new AbortController();
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

  /**
   * Send everything buffered now, one batch at a time through the same
   * in-flight guard as the timer. With `deadlineMs` (the exit path), it gives
   * up at the deadline: the send in flight is aborted, nothing is retried, and
   * what is left is dropped, so a script never hangs on an unreachable server.
   */
  async flush(deadlineMs = Infinity): Promise<void> {
    this.deadline = performance.now() + deadlineMs;
    const abortAt = Number.isFinite(deadlineMs)
      ? setTimeout(() => this.controller.abort(), deadlineMs)
      : null;
    try {
      while ((this.queue.length > 0 || this.inFlight) && performance.now() < this.deadline) {
        await (this.inFlight ?? this.start());
      }
    } finally {
      if (abortAt) clearTimeout(abortAt);
      if (this.controller.signal.aborted) this.controller = new AbortController();
      this.deadline = Infinity;
    }
  }

  stop(): void { clearInterval(this.timer); }

  private kick(): void {
    if (this.inFlight || this.queue.length === 0) return;
    // Too soon after the last send: the timer, or the next record() past
    // flushAt, sends it instead.
    if (performance.now() - this.lastSentAt < this.minGapMs) return;
    void this.start();
  }

  private start(): Promise<void> {
    this.inFlight = this.sendOne().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async sendOne(): Promise<void> {
    const batch = this.queue.splice(0, MAX_BATCH);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0 && performance.now() >= this.deadline) return;
      await this.waitForGap();
      this.lastSentAt = performance.now();
      try { await this.send(batch, this.controller.signal); return; } catch { /* retry once, then drop */ }
      if (this.controller.signal.aborted) {
        this.controller = new AbortController();
        return;
      }
    }
  }

  // Referenced on purpose: this wait only happens while a send or an exit
  // flush is under way, and an unref'd wait would let the process exit with
  // the batch unsent. It never outlasts the flush deadline.
  private async waitForGap(): Promise<void> {
    const wait = Math.min(this.lastSentAt + this.minGapMs, this.deadline) - performance.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  }
}
