export interface ManagedResponseCacheOptions {
  ttlMs: number;
  staleIfErrorMs: number;
  maxEntries: number;
}

export interface ManagedResponseCacheStats {
  entries: number;
  inflight: number;
  maxEntries: number;
  hits: number;
  misses: number;
  coalescedHits: number;
  staleHits: number;
  refreshes: number;
  errors: number;
  evictions: number;
  lastSuccessAt?: string;
  lastErrorAt?: string;
}

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
  staleUntilMs: number;
  lastAccessedAtMs: number;
}

export class ManagedResponseCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly counters = {
    hits: 0,
    misses: 0,
    coalescedHits: 0,
    staleHits: 0,
    refreshes: 0,
    errors: 0,
    evictions: 0
  };
  private lastSuccessAtMs: number | undefined;
  private lastErrorAtMs: number | undefined;

  constructor(private readonly options: ManagedResponseCacheOptions) {}

  async getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (entry && entry.expiresAtMs > now) {
      this.counters.hits += 1;
      entry.lastAccessedAtMs = now;
      return entry.value;
    }

    const existingInflight = this.inflight.get(key);
    if (existingInflight) {
      this.counters.coalescedHits += 1;
      return existingInflight;
    }

    this.counters.misses += 1;
    const refresh = loader()
      .then((value) => {
        this.counters.refreshes += 1;
        this.lastSuccessAtMs = Date.now();
        this.store(key, value);
        return value;
      })
      .catch((error) => {
        this.counters.errors += 1;
        this.lastErrorAtMs = Date.now();
        const staleEntry = this.entries.get(key);
        if (staleEntry && staleEntry.staleUntilMs > Date.now()) {
          this.counters.staleHits += 1;
          staleEntry.lastAccessedAtMs = Date.now();
          return staleEntry.value;
        }
        throw error;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, refresh);
    return refresh;
  }

  stats(): ManagedResponseCacheStats {
    const stats: ManagedResponseCacheStats = {
      entries: this.entries.size,
      inflight: this.inflight.size,
      maxEntries: Math.max(1, this.options.maxEntries),
      ...this.counters
    };
    if (this.lastSuccessAtMs) {
      stats.lastSuccessAt = new Date(this.lastSuccessAtMs).toISOString();
    }
    if (this.lastErrorAtMs) {
      stats.lastErrorAt = new Date(this.lastErrorAtMs).toISOString();
    }
    return stats;
  }

  private store(key: string, value: T): void {
    const now = Date.now();
    this.entries.set(key, {
      value,
      expiresAtMs: now + Math.max(0, this.options.ttlMs),
      staleUntilMs: now + Math.max(0, this.options.ttlMs) + Math.max(0, this.options.staleIfErrorMs),
      lastAccessedAtMs: now
    });
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    const maxEntries = Math.max(1, this.options.maxEntries);
    while (this.entries.size > maxEntries) {
      let oldestKey: string | undefined;
      let oldestAccessedAtMs = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.lastAccessedAtMs < oldestAccessedAtMs) {
          oldestKey = key;
          oldestAccessedAtMs = entry.lastAccessedAtMs;
        }
      }
      if (!oldestKey) {
        return;
      }
      this.entries.delete(oldestKey);
      this.counters.evictions += 1;
    }
  }
}
