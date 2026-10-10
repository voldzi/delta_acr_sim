import type { ManagedResponseCacheStats } from "./response-cache.js";
import type { SourceCacheStats } from "./sources.js";
import type { SafetyFeatureCollection } from "./types.js";

export interface NotificationInputReadiness {
  status: "ready" | "unavailable" | "incomplete";
  snapshotGeneratedAt: string;
  snapshotAgeSeconds: number | null;
  reasons: string[];
}

const FUTURE_TIMESTAMP_TOLERANCE_MS = 5_000;

/**
 * Assesses only the snapshot and cache evidence supplied by the caller.
 * Reaching the known query limit signals possible truncation; a result below
 * that limit does not establish full upstream coverage or pagination.
 */
export function evaluateNotificationInput(
  collection: SafetyFeatureCollection,
  responseCacheStats: ManagedResponseCacheStats,
  sourceCaches: SourceCacheStats[],
  maxSnapshotAgeSeconds: number,
  now: number = Date.now()
): NotificationInputReadiness {
  const reasons = new Set<string>();
  const generatedAt = Date.parse(collection.generatedAt);
  const validNow = Number.isFinite(now);
  const validAgeLimit = Number.isFinite(maxSnapshotAgeSeconds) && maxSnapshotAgeSeconds >= 0;
  const snapshotAgeSeconds = Number.isFinite(generatedAt) && validNow ? Math.max(0, (now - generatedAt) / 1_000) : null;

  if (!validNow) {
    reasons.add("evaluation_time_invalid");
  }
  if (!validAgeLimit) {
    reasons.add("snapshot_age_limit_invalid");
  }
  if (!Number.isFinite(generatedAt)) {
    reasons.add("snapshot_timestamp_invalid");
  } else if (validNow) {
    if (generatedAt - now > FUTURE_TIMESTAMP_TOLERANCE_MS) {
      reasons.add("snapshot_timestamp_future");
    }
    if (validAgeLimit && snapshotAgeSeconds !== null && snapshotAgeSeconds > maxSnapshotAgeSeconds) {
      reasons.add("snapshot_expired");
    }
  }
  if (collection.warnings.length > 0) {
    reasons.add("source_warnings_present");
  }

  addCacheReadinessReasons(reasons, responseCacheStats, "response_cache", maxSnapshotAgeSeconds, now);
  const requestedSources = new Set(collection.query.sources);
  for (const cache of sourceCaches) {
    if (requestedSources.has(cache.sourceId)) {
      addCacheReadinessReasons(reasons, cache, "requested_source_cache", maxSnapshotAgeSeconds, now);
    }
  }

  const unavailable = reasons.size > 0;
  const limitReached = collection.features.length >= collection.query.limit;
  if (limitReached) {
    reasons.add("input_limit_reached");
  }

  return {
    status: unavailable ? "unavailable" : limitReached ? "incomplete" : "ready",
    snapshotGeneratedAt: collection.generatedAt,
    snapshotAgeSeconds,
    reasons: [...reasons]
  };
}

function addCacheReadinessReasons(
  reasons: Set<string>,
  stats: ManagedResponseCacheStats,
  prefix: "response_cache" | "requested_source_cache",
  maxSnapshotAgeSeconds: number,
  now: number
): void {
  if ((stats.unresolvedStaleEntries ?? 0) > 0) {
    reasons.add(`${prefix}_stale_cache_entry_unrecovered`);
  }
  const lastSuccessAt = stats.lastSuccessAt === undefined ? undefined : Date.parse(stats.lastSuccessAt);
  const lastErrorAt = stats.lastErrorAt === undefined ? undefined : Date.parse(stats.lastErrorAt);

  if ((lastSuccessAt !== undefined && !Number.isFinite(lastSuccessAt)) || (lastErrorAt !== undefined && !Number.isFinite(lastErrorAt))) {
    reasons.add(`${prefix}_timestamp_invalid`);
  }
  if (
    Number.isFinite(now) &&
    ((lastSuccessAt !== undefined && lastSuccessAt - now > FUTURE_TIMESTAMP_TOLERANCE_MS) ||
      (lastErrorAt !== undefined && lastErrorAt - now > FUTURE_TIMESTAMP_TOLERANCE_MS))
  ) {
    reasons.add(`${prefix}_timestamp_future`);
  }
  if (
    lastErrorAt !== undefined &&
    Number.isFinite(lastErrorAt) &&
    (lastSuccessAt === undefined || !Number.isFinite(lastSuccessAt) || lastErrorAt >= lastSuccessAt)
  ) {
    reasons.add(`${prefix}_error_unrecovered`);
  }
  if (
    lastSuccessAt !== undefined &&
    Number.isFinite(lastSuccessAt) &&
    Number.isFinite(now) &&
    Number.isFinite(maxSnapshotAgeSeconds) &&
    maxSnapshotAgeSeconds >= 0 &&
    now - lastSuccessAt > maxSnapshotAgeSeconds * 1_000
  ) {
    reasons.add(`${prefix}_success_stale`);
  }
}
