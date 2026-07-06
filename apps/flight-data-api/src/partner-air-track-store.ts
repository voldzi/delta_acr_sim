import type { BoundingBox, FlightObservationMeasurementQuality, FlightTrackKeyKind, PartnerAirTrackSourceKind, RawFlightObservation } from "./types.js";

export interface PartnerAirTrackIngestRecord {
  trackId?: string;
  radarTrackId?: string;
  icao24?: string;
  callsign?: string;
  registration?: string;
  typeDesignator?: string;
  originCountry?: string;
  objectType?: "AIRCRAFT" | "UAV" | "UNKNOWN";
  sourceKind?: PartnerAirTrackSourceKind;
  sensorId?: string;
  remoteId?: string;
  uasRegistration?: string;
  operatorRegistration?: string;
  serialNumber?: string;
  lat?: number;
  lon?: number;
  position?: {
    lat?: number;
    lon?: number;
  };
  altitudeM?: number;
  speedMps?: number;
  headingDeg?: number;
  verticalRateMps?: number;
  onGround?: boolean;
  squawk?: string;
  emergency?: string;
  category?: string;
  measurement?: FlightObservationMeasurementQuality;
  horizontalAccuracyM?: number;
  verticalAccuracyM?: number;
  speedAccuracyMps?: number;
  headingAccuracyDeg?: number;
  rssiDbm?: number;
  rssiDbfs?: number;
  messageCount?: number;
  protocol?: "adsb" | "mode_s" | "remote_id" | "mlat" | "radar" | "unknown";
  channel?: number | string;
  frequencyMhz?: number;
  receiverDistanceM?: number;
  observedAt?: string;
  expiresAt?: string;
  raw?: unknown;
}

export interface PartnerAirTrackIngestPayload {
  sourceName?: string;
  sourceKind?: PartnerAirTrackSourceKind;
  sensorId?: string;
  records?: PartnerAirTrackIngestRecord[];
}

export interface PartnerAirTrackIngestResult {
  accepted: number;
  rejected: number;
  warnings: string[];
  stored: number;
}

export class PartnerAirTrackStore {
  private readonly observations = new Map<string, { observation: RawFlightObservation; expiresAtMs: number }>();

  constructor(
    private readonly options: {
      ttlSeconds: number;
      maxRecords: number;
      sourcePriority: number;
    }
  ) {}

  upsert(payload: PartnerAirTrackIngestPayload, now = new Date()): PartnerAirTrackIngestResult {
    this.prune(now.getTime());
    const records = payload.records ?? [];
    const warnings: string[] = [];
    let accepted = 0;
    let rejected = 0;
    for (const [index, record] of records.entries()) {
      const mapped = this.mapRecord(payload, record, index, now);
      if (!mapped) {
        rejected += 1;
        warnings.push(`record ${index} rejected: missing valid position or track identifier.`);
        continue;
      }
      accepted += 1;
      this.observations.set(mapped.observation.sourceRecordId, mapped);
    }

    this.enforceMaxRecords();
    return {
      accepted,
      rejected,
      warnings,
      stored: this.observations.size
    };
  }

  fetch(bbox?: BoundingBox, now = new Date()): RawFlightObservation[] {
    this.prune(now.getTime());
    return Array.from(this.observations.values())
      .map((item) => item.observation)
      .filter((observation) => !bbox || observationInBbox(observation, bbox));
  }

  stats(now = new Date()): { stored: number; oldestAgeSeconds: number; newestAgeSeconds: number } {
    this.prune(now.getTime());
    const ages = Array.from(this.observations.values())
      .map((item) => Math.max(0, Math.round((now.getTime() - Date.parse(item.observation.seenAt)) / 1000)))
      .filter((age) => Number.isFinite(age));
    return {
      stored: this.observations.size,
      oldestAgeSeconds: ages.length > 0 ? Math.max(...ages) : -1,
      newestAgeSeconds: ages.length > 0 ? Math.min(...ages) : -1
    };
  }

  private mapRecord(
    payload: PartnerAirTrackIngestPayload,
    record: PartnerAirTrackIngestRecord,
    index: number,
    now: Date
  ): { observation: RawFlightObservation; expiresAtMs: number } | undefined {
    const lat = finiteNumber(record.position?.lat ?? record.lat);
    const lon = finiteNumber(record.position?.lon ?? record.lon);
    if (lat === undefined || lon === undefined || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return undefined;
    }
    const sourceKind = record.sourceKind ?? payload.sourceKind ?? "partner";
    const key = trackKeyFor(record, sourceKind);
    if (!key) {
      return undefined;
    }
    const observedAt = normalizeTimestamp(record.observedAt) ?? now.toISOString();
    const expiresAtMs = normalizeTimestamp(record.expiresAt)
      ? Date.parse(normalizeTimestamp(record.expiresAt) as string)
      : now.getTime() + Math.max(5, this.options.ttlSeconds) * 1000;
    const sourceRecordId = `partner_air_tracks:${sourceKind}:${record.sensorId ?? payload.sensorId ?? "unknown"}:${key.kind}:${key.value}`;
    const objectType =
      record.objectType ?? (sourceKind === "remote_id" || sourceKind === "u_space" || record.remoteId || record.uasRegistration ? "UAV" : "UNKNOWN");
    const category = cleanString(record.category) ?? (objectType === "UAV" ? "B6" : undefined);
    return {
      expiresAtMs,
      observation: {
        sourceId: "partner_air_tracks",
        sourceRecordId,
        sourcePriority: this.options.sourcePriority,
        fetchedAt: now.toISOString(),
        seenAt: observedAt,
        icao24: normalizeIcao24(record.icao24),
        trackKey: key.value,
        trackKeyKind: key.kind,
        callsign: cleanString(record.callsign),
        registration: cleanString(record.registration ?? record.uasRegistration),
        typeDesignator: cleanString(record.typeDesignator)?.toUpperCase() ?? (objectType === "UAV" ? "UAV" : undefined),
        originCountry: cleanString(record.originCountry),
        objectType,
        sourceKind,
        sensorId: cleanString(record.sensorId ?? payload.sensorId),
        remoteId: cleanString(record.remoteId),
        uasRegistration: cleanString(record.uasRegistration),
        operatorRegistration: cleanString(record.operatorRegistration),
        serialNumber: cleanString(record.serialNumber),
        lat: round(lat, 6),
        lon: round(lon, 6),
        altitudeM: finiteNumber(record.altitudeM),
        speedMps: finiteNumber(record.speedMps),
        headingDeg: normalizeHeading(record.headingDeg),
        verticalRateMps: finiteNumber(record.verticalRateMps),
        onGround: typeof record.onGround === "boolean" ? record.onGround : undefined,
        squawk: cleanString(record.squawk),
        emergency: cleanString(record.emergency),
        category,
        measurement: measurementFor(payload, record),
        raw: {
          sourceName: payload.sourceName,
          sourceKind,
          ingestIndex: index,
          record: record.raw ?? record
        }
      }
    };
  }

  private prune(nowMs: number): void {
    for (const [key, value] of this.observations.entries()) {
      if (value.expiresAtMs <= nowMs) {
        this.observations.delete(key);
      }
    }
  }

  private enforceMaxRecords(): void {
    const maxRecords = Math.max(1, this.options.maxRecords);
    if (this.observations.size <= maxRecords) {
      return;
    }
    const sorted = Array.from(this.observations.entries()).sort(
      ([, left], [, right]) => Date.parse(left.observation.seenAt) - Date.parse(right.observation.seenAt)
    );
    for (const [key] of sorted.slice(0, this.observations.size - maxRecords)) {
      this.observations.delete(key);
    }
  }
}

function measurementFor(payload: PartnerAirTrackIngestPayload, record: PartnerAirTrackIngestRecord): FlightObservationMeasurementQuality | undefined {
  const sourceKind = record.sourceKind ?? payload.sourceKind;
  const merged: FlightObservationMeasurementQuality = {
    ...record.measurement,
    sourceProtocol: record.measurement?.sourceProtocol ?? record.protocol ?? (sourceKind === "remote_id" ? "remote_id" : undefined),
    receiverId: record.measurement?.receiverId ?? cleanString(record.sensorId ?? payload.sensorId),
    rssiDbm: finiteNumber(record.rssiDbm) ?? record.measurement?.rssiDbm,
    rssiDbfs: finiteNumber(record.rssiDbfs) ?? record.measurement?.rssiDbfs,
    messageCount: finiteNumber(record.messageCount) ?? record.measurement?.messageCount,
    channel: record.channel ?? record.measurement?.channel,
    frequencyMhz: finiteNumber(record.frequencyMhz) ?? record.measurement?.frequencyMhz,
    horizontalAccuracyM: finiteNumber(record.horizontalAccuracyM) ?? record.measurement?.horizontalAccuracyM,
    verticalAccuracyM: finiteNumber(record.verticalAccuracyM) ?? record.measurement?.verticalAccuracyM,
    speedAccuracyMps: finiteNumber(record.speedAccuracyMps) ?? record.measurement?.speedAccuracyMps,
    headingAccuracyDeg: finiteNumber(record.headingAccuracyDeg) ?? record.measurement?.headingAccuracyDeg,
    receiverDistanceM: finiteNumber(record.receiverDistanceM) ?? record.measurement?.receiverDistanceM
  };
  const cleaned = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined && value !== null && value !== "")
  ) as FlightObservationMeasurementQuality;
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function trackKeyFor(record: PartnerAirTrackIngestRecord, sourceKind: PartnerAirTrackSourceKind): { kind: FlightTrackKeyKind; value: string } | undefined {
  const icao24 = normalizeIcao24(record.icao24);
  if (icao24) {
    return { kind: "icao24", value: icao24 };
  }
  const remoteId = cleanKey(record.remoteId ?? record.uasRegistration ?? record.serialNumber);
  if (remoteId) {
    return { kind: "remote_id", value: remoteId };
  }
  const radarTrackId = cleanKey(record.radarTrackId);
  if (radarTrackId) {
    return { kind: "radar_track", value: radarTrackId };
  }
  const partnerTrackId = cleanKey(record.trackId ?? record.registration ?? record.callsign);
  if (partnerTrackId) {
    return { kind: sourceKind === "radar" ? "radar_track" : "partner_track", value: partnerTrackId };
  }
  return undefined;
}

function observationInBbox(observation: RawFlightObservation, bbox: BoundingBox): boolean {
  return (
    typeof observation.lat === "number" &&
    typeof observation.lon === "number" &&
    observation.lon >= bbox.west &&
    observation.lon <= bbox.east &&
    observation.lat >= bbox.south &&
    observation.lat <= bbox.north
  );
}

function normalizeIcao24(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[0-9a-f]{6}$/.test(normalized) ? normalized : undefined;
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function normalizeHeading(value: unknown): number | undefined {
  const number = finiteNumber(value);
  if (number === undefined) {
    return undefined;
  }
  return round(((number % 360) + 360) % 360, 2);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanString(value: string | undefined | null): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function cleanKey(value: string | undefined | null): string | undefined {
  const cleaned = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned ? cleaned.slice(0, 96) : undefined;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
