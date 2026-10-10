import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const MEDIA_NEWS_CONTRACT_VERSION = "sim-crisis-media-context-v1" as const;
export const MEDIA_NEWS_CACHE_TTL_SECONDS = 300;
export const MEDIA_NEWS_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_NEWS_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS_PER_FEED = 100;
const MAX_HEADLINE_LENGTH = 300;
const CT24_HOST = "ct24.ceskatelevize.cz";

export type MediaNewsFeedId = "ct24-main" | "ct24-ostrava" | "ct24-brno";
export type MediaNewsSourceStatus = "ok" | "stale" | "unavailable" | "disabled";
export type MediaNewsErrorCode = "UPSTREAM_HTTP_ERROR" | "UPSTREAM_TIMEOUT" | "UPSTREAM_TOO_LARGE" | "UPSTREAM_INVALID_XML" | "UPSTREAM_UNAVAILABLE";

interface MediaNewsFeed {
  id: MediaNewsFeedId;
  label: string;
  url: string;
  regionCode: "CZ" | "CZ080" | "CZ064";
}

export const MEDIA_NEWS_FEEDS: readonly Readonly<MediaNewsFeed>[] = Object.freeze([
  Object.freeze({ id: "ct24-main", label: "ČT24 – hlavní zprávy", url: "https://ct24.ceskatelevize.cz/rss/hlavni-zpravy", regionCode: "CZ" }),
  Object.freeze({
    id: "ct24-ostrava",
    label: "ČT24 – Moravskoslezský kraj",
    url: "https://ct24.ceskatelevize.cz/rss/rubrika/regiony/moravskoslezsky-kraj-14",
    regionCode: "CZ080"
  }),
  Object.freeze({
    id: "ct24-brno",
    label: "ČT24 – Jihomoravský kraj",
    url: "https://ct24.ceskatelevize.cz/rss/rubrika/regiony/jihomoravsky-kraj-26",
    regionCode: "CZ064"
  })
]);

export interface MediaNewsConfig {
  enabled: boolean;
  requestTimeoutMs?: number;
  staleIfErrorSeconds?: number;
  errorBackoffSeconds?: number;
}

export interface MediaNewsQuery {
  feeds?: MediaNewsFeedId[];
  limit?: number;
}

export interface MediaNewsItem {
  id: string;
  title: string;
  link: string;
  publishedAt: string;
  fetchedAt: string;
  eventAt: null;
  regionCode: "CZ" | "CZ080" | "CZ064";
  regionScope: "feed";
  location: null;
  locationStatus: "unresolved";
  informationalOnly: true;
  notificationEligible: false;
  stale: boolean;
  source: {
    id: "ct24";
    name: "ČT24";
    feedId: MediaNewsFeedId;
    attribution: "Česká televize / ČT24";
  };
}

export interface MediaNewsSourceState {
  id: MediaNewsFeedId;
  label: string;
  feedUrl: string;
  regionCode: "CZ" | "CZ080" | "CZ064";
  regionScope: "feed";
  attribution: "Česká televize / ČT24";
  status: MediaNewsSourceStatus;
  fetchedAt: string | null;
  stale: boolean;
  errorCode: MediaNewsErrorCode | null;
  retryAfterSeconds: number | null;
}

export interface MediaNewsResult {
  contractVersion: typeof MEDIA_NEWS_CONTRACT_VERSION;
  status: "ok" | "degraded" | "disabled";
  generatedAt: string;
  informationalOnly: true;
  notificationEligible: false;
  items: MediaNewsItem[];
  sources: MediaNewsSourceState[];
}

export interface MediaNewsDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export class MediaNewsQueryError extends Error {
  readonly code = "INVALID_MEDIA_NEWS_QUERY";

  constructor(message: string) {
    super(message);
    this.name = "MediaNewsQueryError";
  }
}

/** The URL query accepts only feed IDs, never caller-controlled upstream URLs. */
export function parseMediaNewsQuery(query: Record<string, unknown>): MediaNewsQuery {
  if (Object.keys(query).some((key) => key !== "feeds" && key !== "limit")) {
    throw new MediaNewsQueryError("Only feeds and limit query parameters are supported.");
  }
  const result: MediaNewsQuery = {};
  if (query.feeds !== undefined) {
    if (typeof query.feeds !== "string" || !query.feeds.trim()) {
      throw new MediaNewsQueryError("feeds must be a comma-separated list of supported feed IDs.");
    }
    const values = query.feeds.split(",").map((value) => value.trim());
    if (values.some((value) => !isMediaNewsFeedId(value))) {
      throw new MediaNewsQueryError("feeds contains an unsupported feed ID.");
    }
    result.feeds = [...new Set(values as MediaNewsFeedId[])];
  }
  if (query.limit !== undefined) {
    if (typeof query.limit !== "string" || !/^[1-9]\d{0,2}$/.test(query.limit)) {
      throw new MediaNewsQueryError("limit must be an integer between 1 and 100.");
    }
    result.limit = Number(query.limit);
  }
  validateQuery(result);
  return result;
}

interface FeedSnapshot {
  fetchedAtMs: number;
  items: MediaNewsItem[];
}

interface FeedCache {
  snapshot?: FeedSnapshot;
  inflight?: Promise<FeedSnapshot>;
  errorCode?: MediaNewsErrorCode;
  nextRetryAtMs?: number;
}

interface FeedResult {
  source: MediaNewsSourceState;
  items: MediaNewsItem[];
}

class UpstreamError extends Error {
  constructor(readonly code: MediaNewsErrorCode) {
    super(code);
    this.name = "MediaNewsUpstreamError";
  }
}

/**
 * Lazy, memory-only metadata cache, shared by all queries on this service instance.
 * Separate from SafetyFeature aggregation: RSS never creates geometry or alerts.
 * A fixed three-feed keyspace bounds cache/inflight/backoff storage independently
 * of user query permutations. Stale fallback is explicit, unlike the generic cache.
 */
export class MediaNewsService {
  private readonly cache = new Map<MediaNewsFeedId, FeedCache>();
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly staleIfErrorMs: number;
  private readonly errorBackoffMs: number;

  constructor(
    private readonly config: MediaNewsConfig,
    dependencies: MediaNewsDependencies = {}
  ) {
    this.fetcher = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
    this.timeoutMs = boundedNumber(config.requestTimeoutMs, 8000, 25, 30_000);
    this.staleIfErrorMs = boundedNumber(config.staleIfErrorSeconds, 600, 0, 3600) * 1000;
    this.errorBackoffMs = boundedNumber(config.errorBackoffSeconds, 60, 1, 300) * 1000;
  }

  async query(query: MediaNewsQuery = {}): Promise<MediaNewsResult> {
    validateQuery(query);
    const selected = MEDIA_NEWS_FEEDS.filter((feed) => !query.feeds || query.feeds.includes(feed.id));
    if (!this.config.enabled) {
      return {
        contractVersion: MEDIA_NEWS_CONTRACT_VERSION,
        status: "disabled",
        generatedAt: new Date(this.now()).toISOString(),
        informationalOnly: true,
        notificationEligible: false,
        items: [],
        sources: selected.map((feed) => this.sourceState(feed, "disabled"))
      };
    }
    const results = await Promise.all(selected.map((feed) => this.getFeed(feed)));
    const now = this.now();
    // Re-filter cached metadata at read time: stale cache cannot revive old news.
    const candidates = results.flatMap((result) => result.items).filter((item) => isCurrent(Date.parse(item.publishedAt), now));
    const seen = new Set<string>();
    const items = candidates
      .sort(
        (left, right) =>
          Date.parse(right.publishedAt) - Date.parse(left.publishedAt) || Number(left.stale) - Number(right.stale) || left.id.localeCompare(right.id)
      )
      .filter((item) => {
        if (seen.has(item.link)) return false;
        seen.add(item.link);
        return true;
      })
      .slice(0, query.limit ?? 50);
    return {
      contractVersion: MEDIA_NEWS_CONTRACT_VERSION,
      status: results.some((result) => result.source.status !== "ok") ? "degraded" : "ok",
      generatedAt: new Date(now).toISOString(),
      informationalOnly: true,
      notificationEligible: false,
      items,
      sources: results.map((result) => result.source)
    };
  }

  private async getFeed(feed: Readonly<MediaNewsFeed>): Promise<FeedResult> {
    let state = this.cache.get(feed.id);
    if (!state) {
      state = {};
      this.cache.set(feed.id, state);
    }
    const now = this.now();
    if (state.snapshot && now - state.snapshot.fetchedAtMs < MEDIA_NEWS_CACHE_TTL_SECONDS * 1000) {
      return { source: this.sourceState(feed, "ok", state), items: state.snapshot.items.map((item) => ({ ...item, source: { ...item.source } })) };
    }
    if (!state.inflight && (!state.nextRetryAtMs || state.nextRetryAtMs <= now)) {
      const cache = state;
      cache.inflight = this.loadFeed(feed)
        .then((snapshot) => {
          cache.snapshot = snapshot;
          delete cache.errorCode;
          delete cache.nextRetryAtMs;
          return snapshot;
        })
        .catch((error: unknown) => {
          cache.errorCode = error instanceof UpstreamError ? error.code : "UPSTREAM_UNAVAILABLE";
          cache.nextRetryAtMs = this.now() + this.errorBackoffMs;
          throw error;
        })
        .finally(() => {
          delete cache.inflight;
        });
    }
    if (state.inflight) {
      try {
        await state.inflight;
      } catch {
        // Failure state below is deliberately per feed, with bounded stale fallback.
      }
    }
    const snapshot = state.snapshot;
    const stale = Boolean(snapshot && this.now() - snapshot.fetchedAtMs >= MEDIA_NEWS_CACHE_TTL_SECONDS * 1000);
    const usable = Boolean(snapshot && (!stale || this.now() - snapshot.fetchedAtMs < MEDIA_NEWS_CACHE_TTL_SECONDS * 1000 + this.staleIfErrorMs));
    if (!usable && snapshot) delete state.snapshot;
    return {
      source: this.sourceState(feed, usable ? (stale ? "stale" : "ok") : "unavailable", state),
      items: usable && snapshot ? snapshot.items.map((item) => ({ ...item, source: { ...item.source }, stale })) : []
    };
  }

  private sourceState(feed: Readonly<MediaNewsFeed>, status: MediaNewsSourceStatus, cache?: FeedCache): MediaNewsSourceState {
    return {
      id: feed.id,
      label: feed.label,
      feedUrl: feed.url,
      regionCode: feed.regionCode,
      regionScope: "feed",
      attribution: "Česká televize / ČT24",
      status,
      fetchedAt: cache?.snapshot ? new Date(cache.snapshot.fetchedAtMs).toISOString() : null,
      stale: status === "stale",
      errorCode: status === "ok" || status === "disabled" ? null : (cache?.errorCode ?? "UPSTREAM_UNAVAILABLE"),
      retryAfterSeconds: cache?.nextRetryAtMs ? Math.max(0, Math.ceil((cache.nextRetryAtMs - this.now()) / 1000)) : null
    };
  }

  private async loadFeed(feed: Readonly<MediaNewsFeed>): Promise<FeedSnapshot> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new UpstreamError("UPSTREAM_TIMEOUT"));
      }, this.timeoutMs);
    });
    try {
      const xml = await Promise.race([
        (async () => {
          const response = await this.fetcher(feed.url, {
            signal: controller.signal,
            redirect: "error",
            headers: { accept: "application/rss+xml, application/xml, text/xml", "user-agent": "CSM-SIM/1.0 media-context (RSS metadata only)" }
          });
          if (!response.ok) {
            await cancelBody(response);
            throw new UpstreamError("UPSTREAM_HTTP_ERROR");
          }
          const contentType = response.headers.get("content-type");
          if (contentType && !/^(application\/(?:rss\+xml|xml)|text\/xml)(?:\s*;|$)/i.test(contentType)) {
            await cancelBody(response);
            throw new UpstreamError("UPSTREAM_INVALID_XML");
          }
          const length = response.headers.get("content-length");
          if (length && Number(length) > MEDIA_NEWS_MAX_RESPONSE_BYTES) {
            await cancelBody(response);
            throw new UpstreamError("UPSTREAM_TOO_LARGE");
          }
          return readBoundedXml(response, controller.signal);
        })(),
        deadline
      ]);
      const fetchedAtMs = this.now();
      return { fetchedAtMs, items: normalizeFeed(xml, feed, fetchedAtMs) };
    } catch (error: unknown) {
      if (controller.signal.aborted) throw new UpstreamError("UPSTREAM_TIMEOUT");
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

async function cancelBody(response: globalThis.Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* A rejected upstream body has no usable data. */
  }
}

async function readBoundedXml(response: globalThis.Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new UpstreamError("UPSTREAM_INVALID_XML");
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MEDIA_NEWS_MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* Size rejection remains the outcome. */
        }
        throw new UpstreamError("UPSTREAM_TOO_LARGE");
      }
      chunks.push(value);
    }
    if (signal.aborted) throw new UpstreamError("UPSTREAM_TIMEOUT");
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function normalizeFeed(xml: string, feed: Readonly<MediaNewsFeed>, fetchedAtMs: number): MediaNewsItem[] {
  // No custom entities, DTDs, external entities or expansive nested item payloads.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new UpstreamError("UPSTREAM_INVALID_XML");
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true, maxNestedTags: 20, isArray: (name) => name === "item" });
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    throw new UpstreamError("UPSTREAM_INVALID_XML");
  }
  const channel = object(object(parsed).rss).channel;
  if (!channel || Array.isArray(channel)) throw new UpstreamError("UPSTREAM_INVALID_XML");
  const rawItems = object(channel).item;
  if (rawItems === undefined) return [];
  if (!Array.isArray(rawItems)) throw new UpstreamError("UPSTREAM_INVALID_XML");
  const seen = new Set<string>();
  const items: MediaNewsItem[] = [];
  for (const rawItem of rawItems) {
    const entry = object(rawItem);
    const title = typeof entry.title === "string" ? sanitizeHeadline(entry.title) : "";
    const link = typeof entry.link === "string" ? safeArticleLink(entry.link) : undefined;
    const publishedAtMs = typeof entry.pubDate === "string" ? parsePublicationTime(entry.pubDate) : NaN;
    if (!title || !link || !isCurrent(publishedAtMs, fetchedAtMs) || !isCrisisRelevantHeadline(title) || seen.has(link)) continue;
    seen.add(link);
    items.push({
      id: `ct24-${createHash("sha256").update(link).digest("hex").slice(0, 24)}`,
      title,
      link,
      publishedAt: new Date(publishedAtMs).toISOString(),
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      eventAt: null,
      regionCode: feed.regionCode,
      regionScope: "feed",
      location: null,
      locationStatus: "unresolved",
      informationalOnly: true,
      notificationEligible: false,
      stale: false,
      source: { id: "ct24", name: "ČT24", feedId: feed.id, attribution: "Česká televize / ČT24" }
    });
  }
  return items.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt)).slice(0, MAX_ITEMS_PER_FEED);
}

function parsePublicationTime(value: string): number {
  // Require a full timestamp with timezone; never guess the local timezone or event time.
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i;
  const rfc =
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?\s+(?:[+-]\d{4}|GMT|UTC)$/i;
  if (!iso.test(value) && !rfc.test(value)) return NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return NaN;
  // JS rolls invalid February dates into March. Reject that normalization explicitly.
  const parts = iso.test(value) ? /^([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(value) : /\s([0-9]{1,2})\s([A-Za-z]{3})\s([0-9]{4})/.exec(value);
  if (!parts) return NaN;
  const year = Number(iso.test(value) ? parts[1] : parts[3]);
  const month = iso.test(value) ? Number(parts[2]) : "jan feb mar apr may jun jul aug sep oct nov dec".split(" ").indexOf((parts[2] ?? "").toLowerCase()) + 1;
  const day = Number(iso.test(value) ? parts[3] : parts[1]);
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return NaN;
  return parsed;
}

function safeArticleLink(value: string): string | undefined {
  if (value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== CT24_HOST || url.username || url.password || url.port) return undefined;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(?:fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function sanitizeHeadline(value: string): string {
  let title = value;
  for (let pass = 0; pass < 3; pass += 1) {
    title = title.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name: string) => {
      if (name.startsWith("#")) {
        const code = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
      }
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[name.toLowerCase()] ?? entity;
    });
  }
  return title
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_HEADLINE_LENGTH);
}

function isCrisisRelevantHeadline(title: string): boolean {
  const normalized = title.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (
    /\b(?:cviceni|nacvik|simulace|vyroci|vzpominka|vzpominky|retrospektiv\w*|pred\s+\S+\s+lety|pred\s+(?:rokem|lety)|loni|lonsk\w*|historick\w*)\b/.test(
      normalized
    )
  )
    return false;
  if (
    /\b(?:ukrajin\w*|rusk\w*|izrael\w*|gaz[aeuy]|libanon\w*|syr\w*|iran\w*|usa|americ\w*|kaliforni\w*|florid\w*|cinsk\w*|cine|japonsk\w*|tureck\w*|reck\w*|spanelsk\w*|italsk\w*|nemeck\w*|polsk\w*|slovensk\w*|rakousk\w*|franci\w*|francouz\w*|portugalsk\w*|indii|indick\w*|pakistan\w*|nepal\w*|banglades\w*|australi\w*|kanad\w*|brazil\w*|mexick\w*|mexik\w*|korej\w*|tchajwan\w*|filipin\w*|indones\w*|madarsk\w*|brit\w*|londyn\w*|pariz\w*|berlin\w*|madrid\w*|moskv\w*|kyjev\w*|peking\w*|zahranici)\b/.test(
      normalized
    )
  )
    return false;
  return (
    /\b(?:pozar\w*|povod\w*|zaplav\w*|evaku\w*|kalamit\w*|tornado\w*|lavin\w*|sesuv\w*|zemetres\w*|vybuch\w*)\b/.test(normalized) ||
    /(?:unik\w*\s+(?:plyn\w*|nebezpec\w*|chemick\w*)|kontamin\w*|nebezpec\w*\s+(?:latk\w*|pocasi|vitr\w*)|vystrah\w*\s+(?:pred|na)|siln\w*\s+(?:bour\w*|vitr\w*|dest\w*)|extrem\w*\s+(?:pocasi|teplot\w*|dest\w*|vitr\w*)|vypad\w*\s+(?:elektr\w*|proud\w*|dodavek\s+vody)|bez\s+(?:elektriny|proudu|pitne\s+vody)|poruch\w*\s+vodovod\w*|havar\w*\s+(?:vodovod\w*|plynovod\w*))/.test(
      normalized
    ) ||
    /(?:uzavir\w*|uzavren\w*|neprujezd\w*|nesjizdn\w*|omezen\w*\s+provoz\w*).*(?:dalnic\w*|silnic\w*|zeleznic\w*|trat\w*|tunel\w*|most\w*|dopravy)|(?:dalnic\w*|silnic\w*|zeleznic\w*|trat\w*|tunel\w*|most\w*).*(?:uzavir\w*|uzavren\w*|neprujezd\w*|nesjizdn\w*|omezen\w*\s+provoz\w*)/.test(
      normalized
    )
  );
}

function isCurrent(publishedAtMs: number, now: number): boolean {
  return Number.isFinite(publishedAtMs) && publishedAtMs <= now && now - publishedAtMs <= MAX_NEWS_AGE_MS;
}

function validateQuery(query: MediaNewsQuery): void {
  if (
    query.feeds &&
    (!Array.isArray(query.feeds) || !query.feeds.length || query.feeds.length > MEDIA_NEWS_FEEDS.length || query.feeds.some((feed) => !isMediaNewsFeedId(feed)))
  ) {
    throw new MediaNewsQueryError("feeds must contain supported feed IDs.");
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)) {
    throw new MediaNewsQueryError("limit must be an integer between 1 and 100.");
  }
}

function isMediaNewsFeedId(value: string): value is MediaNewsFeedId {
  return MEDIA_NEWS_FEEDS.some((feed) => feed.id === value);
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function boundedNumber(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value!))) : fallback;
}
