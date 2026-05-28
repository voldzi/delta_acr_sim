import { createClient, type RedisClientType } from "redis";
import type { SituationDataConfig } from "./config.js";
import type { SharedResponseCacheStore } from "./response-cache.js";

export async function createSharedResponseCacheStore(config: SituationDataConfig): Promise<SharedResponseCacheStore | undefined> {
  if (!config.sharedCacheRedisUrl) {
    return undefined;
  }

  const client = createClient({
    url: config.sharedCacheRedisUrl,
    socket: {
      connectTimeout: config.sharedCacheConnectTimeoutMs,
      reconnectStrategy(retries) {
        return Math.min(1000, 50 * retries);
      }
    }
  });

  client.on("error", (error) => {
    console.warn(`Situation data shared cache error: ${error instanceof Error ? error.message : String(error)}`);
  });

  try {
    await client.connect();
    return new RedisSharedResponseCacheStore(client as RedisClientType);
  } catch (error) {
    console.warn(`Situation data shared cache disabled: ${error instanceof Error ? error.message : String(error)}`);
    try {
      await client.quit();
    } catch {
      // Ignore cleanup errors; the API can run with local in-memory cache.
    }
    return undefined;
  }
}

class RedisSharedResponseCacheStore implements SharedResponseCacheStore {
  constructor(private readonly client: RedisClientType) {}

  async get(key: string): Promise<string | undefined> {
    const value = await this.client.get(key);
    return value ?? undefined;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.client.set(key, value, { PX: Math.max(1, Math.trunc(ttlMs)) });
  }

  isAvailable(): boolean {
    return this.client.isReady;
  }
}
