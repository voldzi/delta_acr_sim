import { createHash } from "node:crypto";

export interface SharedResponseCacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  isAvailable(): boolean;
}

export interface ManagedResponseCacheOptions {
  ttlMs: number;
  staleIfErrorMs: number;
  maxEntries: number;
  sharedStore?: SharedResponseCacheStore;
  sharedKeyPrefix?: string;
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
  sharedEnabled: boolean;
  sharedAvailable: boolean;
  sharedHits: number;
  sharedMisses: number;
  sharedStaleHits: number;
  sharedWrites: number;
  sharedErrors: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
  staleUntilMs: number;
  lastAccessedAtMs: number;
}

interface SharedCachePayload<T> {
  value: T;
  expiresAtMs: number;
  staleUntilMs: number;
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
    evictions: 0,
    sharedHits: 0,
    sharedMisses: 0,
    sharedStaleHits: 0,
    sharedWrites: 0,
    sharedErrors: 0
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

    const sharedEntry = await this.readSharedEntry(key);
    if (sharedEntry && sharedEntry.expiresAtMs > Date.now()) {
      this.counters.hits += 1;
      this.counters.sharedHits += 1;
      this.storeEntry(key, sharedEntry.value, sharedEntry.expiresAtMs, sharedEntry.staleUntilMs);
      return sharedEntry.value;
    }

    const postSharedInflight = this.inflight.get(key);
    if (postSharedInflight) {
      this.counters.coalescedHits += 1;
      return postSharedInflight;
    }

    this.counters.misses += 1;
    const refresh = loader()
      .then(async (value) => {
        this.counters.refreshes += 1;
        this.lastSuccessAtMs = Date.now();
        await this.store(key, value);
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
        if (sharedEntry && sharedEntry.staleUntilMs > Date.now()) {
          this.counters.sharedStaleHits += 1;
          this.storeEntry(key, sharedEntry.value, sharedEntry.expiresAtMs, sharedEntry.staleUntilMs);
          return sharedEntry.value;
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
      sharedEnabled: Boolean(this.options.sharedStore),
      sharedAvailable: Boolean(this.options.sharedStore?.isAvailable()),
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

  private async store(key: string, value: T): Promise<void> {
    const now = Date.now();
    const expiresAtMs = now + Math.max(0, this.options.ttlMs);
    const staleUntilMs = expiresAtMs + Math.max(0, this.options.staleIfErrorMs);
    this.storeEntry(key, value, expiresAtMs, staleUntilMs);
    await this.writeSharedEntry(key, { value, expiresAtMs, staleUntilMs });
  }

  private storeEntry(key: string, value: T, expiresAtMs: number, staleUntilMs: number): void {
    this.entries.set(key, {
      value,
      expiresAtMs,
      staleUntilMs,
      lastAccessedAtMs: Date.now()
    });
    this.evictIfNeeded();
  }

  private async readSharedEntry(key: string): Promise<SharedCachePayload<T> | undefined> {
    const store = this.options.sharedStore;
    if (!store) {
      return undefined;
    }
    try {
      const raw = await store.get(this.sharedKey(key));
      if (!raw) {
        this.counters.sharedMisses += 1;
        return undefined;
      }
      const parsed = JSON.parse(raw) as Partial<SharedCachePayload<T>>;
      if (!parsed || typeof parsed.expiresAtMs !== "number" || typeof parsed.staleUntilMs !== "number" || !("value" in parsed)) {
        this.counters.sharedErrors += 1;
        return undefined;
      }
      return {
        value: parsed.value as T,
        expiresAtMs: parsed.expiresAtMs,
        staleUntilMs: parsed.staleUntilMs
      };
    } catch {
      this.counters.sharedErrors += 1;
      return undefined;
    }
  }

  private async writeSharedEntry(key: string, payload: SharedCachePayload<T>): Promise<void> {
    const store = this.options.sharedStore;
    if (!store) {
      return;
    }
    try {
      const ttlMs = Math.max(1, payload.staleUntilMs - Date.now());
      await store.set(this.sharedKey(key), JSON.stringify(payload), ttlMs);
      this.counters.sharedWrites += 1;
    } catch {
      this.counters.sharedErrors += 1;
    }
  }

  private sharedKey(key: string): string {
    const prefix = this.options.sharedKeyPrefix ?? "managed-response-cache";
    return `${prefix}:${createHash("sha256").update(key).digest("hex")}`;
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
