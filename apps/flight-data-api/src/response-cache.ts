export interface ManagedResponseCacheOptions {
  ttlMs: number;
  staleIfErrorMs: number;
  staleWhileRevalidateMs?: number;
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
      this.touchEntry(key, entry, now);
      return entry.value;
    }

    if (entry && entry.staleUntilMs > now && entry.expiresAtMs + Math.max(0, this.options.staleWhileRevalidateMs ?? 0) > now) {
      this.counters.staleHits += 1;
      this.touchEntry(key, entry, now);
      if (!this.inflight.has(key)) {
        this.inflight.set(key, this.refresh(key, loader));
      } else {
        this.counters.coalescedHits += 1;
      }
      return entry.value;
    }

    const existingInflight = this.inflight.get(key);
    if (existingInflight) {
      this.counters.coalescedHits += 1;
      return existingInflight;
    }

    this.counters.misses += 1;
    const refresh = this.refresh(key, loader);

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

  private refresh(key: string, loader: () => Promise<T>): Promise<T> {
    return loader()
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
          this.touchEntry(key, staleEntry, Date.now());
          return staleEntry.value;
        }
        throw error;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
  }

  private store(key: string, value: T): void {
    const now = Date.now();
    this.entries.delete(key);
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
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }
      this.entries.delete(oldestKey);
      this.counters.evictions += 1;
    }
  }

  private touchEntry(key: string, entry: CacheEntry<T>, now: number): void {
    entry.lastAccessedAtMs = now;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
}
