import { AsyncLocalStorage } from "node:async_hooks";

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
  unresolvedStaleEntries?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
  staleUntilMs: number;
  lastAccessedAtMs: number;
  lastRefreshFailed: boolean;
}

interface CacheLoadResult<T> {
  value: T;
  staleFallbackUsed: boolean;
}

interface CacheReadEvidence {
  staleFallbackUsed: boolean;
}

const cacheReadEvidence = new AsyncLocalStorage<CacheReadEvidence>();

/** Request-scoped, sanitized evidence. No cache key or provider payload is collected. */
export async function collectManagedResponseCacheEvidence<T>(operation: () => Promise<T>): Promise<{ value: T; staleFallbackUsed: boolean }> {
  const evidence: CacheReadEvidence = { staleFallbackUsed: false };
  const value = await cacheReadEvidence.run(evidence, operation);
  return { value, staleFallbackUsed: evidence.staleFallbackUsed };
}

async function unwrapCacheLoad<T>(load: Promise<CacheLoadResult<T>>): Promise<T> {
  const result = await load;
  if (result.staleFallbackUsed) {
    const evidence = cacheReadEvidence.getStore();
    if (evidence) evidence.staleFallbackUsed = true;
  }
  return result.value;
}

export class ManagedResponseCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inflight = new Map<string, Promise<CacheLoadResult<T>>>();
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

    const existingInflight = this.inflight.get(key);
    if (existingInflight) {
      this.counters.coalescedHits += 1;
      return unwrapCacheLoad(existingInflight);
    }

    this.counters.misses += 1;
    const refresh = loader()
      .then((value) => {
        this.counters.refreshes += 1;
        this.lastSuccessAtMs = Date.now();
        this.store(key, value);
        return { value, staleFallbackUsed: false };
      })
      .catch((error) => {
        this.counters.errors += 1;
        this.lastErrorAtMs = Date.now();
        const staleEntry = this.entries.get(key);
        if (staleEntry) {
          // Only successful replacement of this exact key resolves its failure.
          // A newer success for a different key is not recovery evidence.
          staleEntry.lastRefreshFailed = true;
        }
        if (staleEntry && staleEntry.staleUntilMs > Date.now()) {
          this.counters.staleHits += 1;
          this.touchEntry(key, staleEntry, Date.now());
          return { value: staleEntry.value, staleFallbackUsed: true };
        }
        throw error;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, refresh);
    return unwrapCacheLoad(refresh);
  }

  stats(): ManagedResponseCacheStats {
    const stats: ManagedResponseCacheStats = {
      entries: this.entries.size,
      inflight: this.inflight.size,
      maxEntries: Math.max(1, this.options.maxEntries),
      unresolvedStaleEntries: [...this.entries.values()].filter((entry) => entry.lastRefreshFailed).length,
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
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAtMs: now + Math.max(0, this.options.ttlMs),
      staleUntilMs: now + Math.max(0, this.options.ttlMs) + Math.max(0, this.options.staleIfErrorMs),
      lastAccessedAtMs: now,
      lastRefreshFailed: false
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
