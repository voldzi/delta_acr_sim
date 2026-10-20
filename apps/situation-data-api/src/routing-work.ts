export class RoutingCapacityError extends Error {}

/** One process-wide FIFO budget for expensive engine requests, not status checks. */
export class RoutingWorkQueue {
  private active = 0;
  private started = 0;
  private rejected = 0;
  private waiting: Array<{ start: () => void; timer: ReturnType<typeof setTimeout> }> = [];
  constructor(
    private readonly concurrency = 4,
    private readonly maxQueue = 32,
    private readonly waitMs = 5000
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxQueue) {
        this.rejected++;
        throw new RoutingCapacityError("Routing capacity is busy; retry later.");
      }
      await new Promise<void>((resolve, reject) => {
        const item = {
          start: resolve,
          timer: setTimeout(() => {
            const index = this.waiting.indexOf(item);
            if (index >= 0) this.waiting.splice(index, 1);
            this.rejected++;
            reject(new RoutingCapacityError("Routing queue wait expired; retry later."));
          }, this.waitMs)
        };
        this.waiting.push(item);
      });
    } else {
      this.active++;
    }
    this.started++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.start();
      } else this.active--;
    }
  }
  stats() {
    return { active: this.active, queued: this.waiting.length, started: this.started, rejected: this.rejected };
  }
}

/** No stored result or stale reuse. Every caller retains its own final safety checks. */
export class RoutingSingleFlight<T> {
  private coalesced = 0;
  private pending = new Map<string, { value: Promise<T>; callers: number }>();
  constructor(private readonly maxCallers = 32) {}
  async run(key: string, work: () => Promise<T>): Promise<T> {
    let entry = this.pending.get(key);
    if (entry) {
      if (entry.callers >= this.maxCallers) throw new RoutingCapacityError("Too many identical routing requests; retry later.");
      entry.callers++;
      this.coalesced++;
    } else {
      entry = { value: Promise.resolve().then(work), callers: 1 };
      this.pending.set(key, entry);
    }
    try {
      return structuredClone(await entry.value);
    } finally {
      entry.callers--;
      if (entry.callers === 0 && this.pending.get(key) === entry) this.pending.delete(key);
    }
  }
  stats() {
    return { inflight: this.pending.size, coalesced: this.coalesced };
  }
}

export const engineWork = new RoutingWorkQueue();
export const statusWork = new RoutingWorkQueue(4, 64, 2000);
