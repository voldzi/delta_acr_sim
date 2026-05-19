import type { CanonicalEventEnvelope, PublisherMode } from "@delta-acr/contracts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type QueueState =
  | "PENDING"
  | "SENDING"
  | "SENT"
  | "RETRY_SCHEDULED"
  | "DEAD_LETTER"
  | "DRY_RUN_VALIDATED";

export interface PublisherQueueItem {
  queueId: string;
  eventId: string;
  idempotencyKey: string;
  payloadHash: string;
  state: QueueState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  lastError?: string;
  response?: unknown;
  event: CanonicalEventEnvelope;
}

export interface PublisherConfig {
  mode: PublisherMode;
  mainCopBaseUrl?: string;
  sourceSystemId: string;
  adapterVersion: string;
  maxRetries: number;
}

export interface PublisherStatus {
  mode: PublisherMode;
  queueSize: number;
  deadLetterSize: number;
  publishingEnabled: boolean;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

export interface PublisherStoreData {
  items: PublisherQueueItem[];
  publishingEnabled: boolean;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

const LIVE_PUBLISH_TIMEOUT_MS = 10_000;
const MAX_RETAINED_DELIVERED_ITEMS = 2000;
const MAX_DUE_RETRIES_PER_TICK = 25;

export class PublisherClient {
  private data: PublisherStoreData = { items: [], publishingEnabled: true };

  constructor(
    private readonly config: PublisherConfig,
    private readonly storePath: string
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.storePath, "utf8");
      this.data = JSON.parse(raw) as PublisherStoreData;
      this.pruneRetainedItems();
      await this.persist();
    } catch {
      this.data = { items: [], publishingEnabled: true };
      await this.persist();
    }
  }

  status(): PublisherStatus {
    return {
      mode: this.config.mode,
      queueSize: this.data.items.filter((item) => !isDeliveredState(item.state)).length,
      deadLetterSize: this.data.items.filter((item) => item.state === "DEAD_LETTER").length,
      publishingEnabled: this.data.publishingEnabled,
      lastSuccessAt: this.data.lastSuccessAt,
      lastFailureAt: this.data.lastFailureAt
    };
  }

  listQueue(): PublisherQueueItem[] {
    return [...this.data.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async stopPublishing(): Promise<void> {
    this.data.publishingEnabled = false;
    await this.persist();
  }

  async enablePublishing(): Promise<void> {
    this.data.publishingEnabled = true;
    await this.persist();
  }

  async clearQueue(): Promise<number> {
    const count = this.data.items.length;
    this.data.items = [];
    await this.persist();
    return count;
  }

  async enqueue(event: CanonicalEventEnvelope): Promise<PublisherQueueItem> {
    assertSynthetic(event);
    const now = new Date().toISOString();
    const item: PublisherQueueItem = {
      queueId: randomUUID(),
      eventId: event.eventId,
      idempotencyKey: event.eventId,
      payloadHash: hashPayload(event),
      state: "PENDING",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      event
    };
    this.data.items.push(item);
    await this.persist();
    return item;
  }

  async publishEvent(event: CanonicalEventEnvelope): Promise<PublisherQueueItem> {
    const item = await this.enqueue(event);
    return this.processItem(item.queueId);
  }

  async processItem(queueId: string): Promise<PublisherQueueItem> {
    const item = this.data.items.find((entry) => entry.queueId === queueId);
    if (!item) {
      throw new Error(`Queue item not found: ${queueId}`);
    }

    if (!this.data.publishingEnabled) {
      item.state = "RETRY_SCHEDULED";
      item.lastError = "Publishing is stopped";
      item.nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
      item.updatedAt = new Date().toISOString();
      await this.persist();
      return item;
    }

    if (this.config.mode === "DRY_RUN") {
      item.state = "DRY_RUN_VALIDATED";
      item.response = {
        accepted: true,
        dryRun: true,
        eventId: item.eventId,
        correlationId: item.event.correlationId
      };
      item.updatedAt = new Date().toISOString();
      this.data.lastSuccessAt = item.updatedAt;
      await this.persist();
      return item;
    }

    item.state = "SENDING";
    item.attempts += 1;
    item.updatedAt = new Date().toISOString();
    await this.persist();

    try {
      const response =
        this.config.mode === "MOCK" ? await mockCopResponse(item.event) : await this.sendLive(item.event, item.idempotencyKey);

      item.response = response;
      item.state = "SENT";
      item.updatedAt = new Date().toISOString();
      this.data.lastSuccessAt = item.updatedAt;
      await this.persist();
      return item;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown publisher error";
      item.lastError = message;
      item.updatedAt = new Date().toISOString();
      this.data.lastFailureAt = item.updatedAt;

      if (item.attempts >= this.config.maxRetries) {
        item.state = "DEAD_LETTER";
      } else {
        item.state = "RETRY_SCHEDULED";
        item.nextAttemptAt = new Date(Date.now() + backoffMs(item.attempts)).toISOString();
      }

      await this.persist();
      return item;
    }
  }

  async retryQueue(queueIds?: string[]): Promise<number> {
    const candidates = this.data.items.filter((item) => {
      const selected = !queueIds?.length || queueIds.includes(item.queueId);
      return selected && (item.state === "RETRY_SCHEDULED" || item.state === "DEAD_LETTER" || item.state === "PENDING");
    });

    for (const item of candidates) {
      await this.processItem(item.queueId);
    }

    return candidates.length;
  }

  async retryDueQueue(now: Date = new Date(), limit = MAX_DUE_RETRIES_PER_TICK): Promise<number> {
    const candidates = this.data.items.filter((item) => {
      if (item.state !== "PENDING" && item.state !== "RETRY_SCHEDULED") {
        return false;
      }
      return !item.nextAttemptAt || new Date(item.nextAttemptAt).getTime() <= now.getTime();
    }).slice(0, limit);

    for (const item of candidates) {
      await this.processItem(item.queueId);
    }

    return candidates.length;
  }

  async testConnection(): Promise<{ ok: boolean; mode: PublisherMode; latencyMs: number }> {
    const start = performance.now();
    if (this.config.mode === "LIVE" && !this.config.mainCopBaseUrl) {
      throw new Error("MAIN_COP_BASE_URL is required for LIVE mode");
    }
    return {
      ok: true,
      mode: this.config.mode,
      latencyMs: Math.round(performance.now() - start)
    };
  }

  private async sendLive(event: CanonicalEventEnvelope, idempotencyKey: string): Promise<unknown> {
    if (!this.config.mainCopBaseUrl) {
      throw new Error("MAIN_COP_BASE_URL is not configured");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_PUBLISH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.config.mainCopBaseUrl.replace(/\/$/, "")}/api/v1/ingest/events`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer local-pilot-token",
          "x-source-system-id": this.config.sourceSystemId,
          "x-idempotency-key": idempotencyKey,
          "x-contract-version": event.contractVersion,
          "x-correlation-id": event.correlationId
        },
        body: JSON.stringify(event)
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`COP ingest timed out after ${LIVE_PUBLISH_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`COP ingest failed with ${response.status}: ${JSON.stringify(payload)}`);
    }
    return payload;
  }

  private async persist(): Promise<void> {
    this.pruneRetainedItems();
    await mkdir(dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tempPath, this.storePath);
  }

  private pruneRetainedItems(): void {
    const activeItems = this.data.items.filter((item) => !isDeliveredState(item.state));
    const retainedDeliveredItems = this.data.items
      .filter((item) => isDeliveredState(item.state))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_RETAINED_DELIVERED_ITEMS);
    this.data.items = [...activeItems, ...retainedDeliveredItems];
  }
}

export function assertSynthetic(event: CanonicalEventEnvelope): void {
  if (event.simulation.synthetic !== true) {
    throw new Error("Event rejected: simulation.synthetic must be true");
  }
  if (!event.classification.handlingCaveats.includes("SYNTHETIC")) {
    throw new Error("Event rejected: classification.handlingCaveats must include SYNTHETIC");
  }
}

function hashPayload(event: CanonicalEventEnvelope): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function backoffMs(attempts: number): number {
  const base = Math.min(60_000, 1000 * 2 ** attempts);
  const jitter = Math.round(base * 0.1);
  return base + jitter;
}

function isDeliveredState(state: QueueState): boolean {
  return state === "SENT" || state === "DRY_RUN_VALIDATED";
}

async function mockCopResponse(event: CanonicalEventEnvelope): Promise<unknown> {
  return {
    accepted: true,
    eventId: event.eventId,
    ingestId: randomUUID(),
    receivedAt: new Date().toISOString(),
    status: "QUEUED",
    correlationId: event.correlationId
  };
}
