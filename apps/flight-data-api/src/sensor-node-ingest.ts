import { createHash } from "node:crypto";
import { PartnerAirTrackStore, type PartnerAirTrackIngestRecord } from "./partner-air-track-store.js";
import type { FlightObservationMeasurementQuality } from "./types.js";

export interface SensorNodeObservationBatch {
  schema?: string;
  sensor_id?: string;
  sensorId?: string;
  sent_at_utc?: string;
  sentAt?: string;
  node?: Record<string, unknown>;
  sensor?: Record<string, unknown>;
  observations?: SensorNodeObservation[];
  signature?: string;
}

export interface SensorNodeObservation {
  schema?: string;
  observation_id?: string;
  observationId?: string;
  type?: string;
  kind?: string;
  observed_at_utc?: string;
  observedAt?: string;
  sensor?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export interface SensorNodeStatus {
  sensorId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastBatchAt: string;
  lastLocation?: {
    lat: number;
    lon: number;
    heightM?: number;
  };
  capabilities: string[];
  observationCounts: {
    adsb: number;
    remoteId: number;
    weather: number;
    health: number;
    rejected: number;
  };
  latestWeather?: {
    observedAt: string;
    temperatureC?: number;
    humidityPercent?: number;
    pressureHpa?: number;
  };
  latestHealth?: {
    observedAt: string;
    uptimeSeconds?: number;
    cpuTemperatureC?: number;
    cpuLoadPercent?: number;
    diskFreePercent?: number;
    gpsFix?: boolean;
    internetReachable?: boolean;
    adsbMessagesPerMinute?: number;
    remoteIdMessagesPerMinute?: number;
  };
}

export interface SensorNodeIngestResult {
  accepted: number;
  rejected: number;
  trackAccepted: number;
  trackRejected: number;
  weatherAccepted: number;
  healthAccepted: number;
  warnings: string[];
  storedTrackCount: number;
  sensorStats: ReturnType<SensorNodeStore["stats"]>;
}

export class SensorNodeStore {
  private readonly nodes = new Map<string, SensorNodeStatus>();

  constructor(private readonly options: { ttlSeconds: number; maxNodes: number }) {}

  upsertStatus(sensorId: string, patch: Partial<SensorNodeStatus>, now = new Date()): void {
    this.prune(now.getTime());
    const existing = this.nodes.get(sensorId);
    const firstSeenAt = existing?.firstSeenAt ?? now.toISOString();
    const next: SensorNodeStatus = {
      sensorId,
      firstSeenAt,
      lastSeenAt: patch.lastSeenAt ?? existing?.lastSeenAt ?? now.toISOString(),
      lastBatchAt: patch.lastBatchAt ?? existing?.lastBatchAt ?? now.toISOString(),
      lastLocation: patch.lastLocation ?? existing?.lastLocation,
      capabilities: uniqueStrings([...(existing?.capabilities ?? []), ...(patch.capabilities ?? [])]),
      observationCounts: {
        adsb: (existing?.observationCounts.adsb ?? 0) + (patch.observationCounts?.adsb ?? 0),
        remoteId: (existing?.observationCounts.remoteId ?? 0) + (patch.observationCounts?.remoteId ?? 0),
        weather: (existing?.observationCounts.weather ?? 0) + (patch.observationCounts?.weather ?? 0),
        health: (existing?.observationCounts.health ?? 0) + (patch.observationCounts?.health ?? 0),
        rejected: (existing?.observationCounts.rejected ?? 0) + (patch.observationCounts?.rejected ?? 0)
      },
      latestWeather: patch.latestWeather ?? existing?.latestWeather,
      latestHealth: patch.latestHealth ?? existing?.latestHealth
    };
    this.nodes.set(sensorId, next);
    this.enforceMaxNodes();
  }

  list(now = new Date()): SensorNodeStatus[] {
    this.prune(now.getTime());
    return Array.from(this.nodes.values()).sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));
  }

  stats(now = new Date()): { stored: number; oldestAgeSeconds: number; newestAgeSeconds: number } {
    this.prune(now.getTime());
    const ages = this.list(now)
      .map((node) => Math.max(0, Math.round((now.getTime() - Date.parse(node.lastSeenAt)) / 1000)))
      .filter((age) => Number.isFinite(age));
    return {
      stored: this.nodes.size,
      oldestAgeSeconds: ages.length > 0 ? Math.max(...ages) : -1,
      newestAgeSeconds: ages.length > 0 ? Math.min(...ages) : -1
    };
  }

  private prune(nowMs: number): void {
    const ttlMs = Math.max(60, this.options.ttlSeconds) * 1000;
    for (const [sensorId, node] of this.nodes.entries()) {
      if (Date.parse(node.lastSeenAt) + ttlMs <= nowMs) {
        this.nodes.delete(sensorId);
      }
    }
  }

  private enforceMaxNodes(): void {
    const maxNodes = Math.max(1, this.options.maxNodes);
    if (this.nodes.size <= maxNodes) {
      return;
    }
    const sorted = Array.from(this.nodes.entries()).sort(([, left], [, right]) => Date.parse(left.lastSeenAt) - Date.parse(right.lastSeenAt));
    for (const [sensorId] of sorted.slice(0, this.nodes.size - maxNodes)) {
      this.nodes.delete(sensorId);
    }
  }
}

export function ingestSensorNodeBatch(
  batch: SensorNodeObservationBatch,
  partnerAirTracks: PartnerAirTrackStore,
  sensorNodes: SensorNodeStore,
  now = new Date()
): SensorNodeIngestResult {
  const sensorId = cleanString(batch.sensor_id ?? batch.sensorId);
  const observations = Array.isArray(batch.observations) ? batch.observations : [];
  const warnings: string[] = [];
  const records: PartnerAirTrackIngestRecord[] = [];
  const counts = { adsb: 0, remoteId: 0, weather: 0, health: 0, rejected: 0 };
  if (!sensorId) {
    return {
      accepted: 0,
      rejected: Math.max(1, observations.length),
      trackAccepted: 0,
      trackRejected: 0,
      weatherAccepted: 0,
      healthAccepted: 0,
      warnings: ["sensor_id is required."],
      storedTrackCount: partnerAirTracks.stats(now).stored,
      sensorStats: sensorNodes.stats(now)
    };
  }
  let latestWeather: SensorNodeStatus["latestWeather"];
  let latestHealth: SensorNodeStatus["latestHealth"];
  let lastLocation = locationFrom(batch.sensor ?? batch.node);
  const sentAt = normalizeTimestamp(batch.sent_at_utc ?? batch.sentAt) ?? now.toISOString();

  for (const [index, observation] of observations.entries()) {
    const observedAt = normalizeTimestamp(observation.observed_at_utc ?? observation.observedAt) ?? sentAt;
    const type = normalizeObservationType(observation.type ?? observation.kind ?? observation.schema);
    const payload = observation.payload ?? {};
    lastLocation = locationFrom(observation.sensor) ?? lastLocation;

    if (type === "adsb") {
      const record = mapAdsbObservation(sensorId, observation, payload, observedAt, index);
      if (record) {
        counts.adsb += 1;
        records.push(record);
      } else {
        counts.rejected += 1;
        warnings.push(`observation ${index} rejected: ADS-B observation is missing ICAO24 or valid position.`);
      }
      continue;
    }

    if (type === "remote_id") {
      const record = mapRemoteIdObservation(sensorId, observation, payload, observedAt, index);
      if (record) {
        counts.remoteId += 1;
        records.push(record);
      } else {
        counts.rejected += 1;
        warnings.push(`observation ${index} rejected: Remote ID observation is missing UAS id hash or valid position.`);
      }
      continue;
    }

    if (type === "weather") {
      counts.weather += 1;
      latestWeather = {
        observedAt,
        temperatureC: finiteNumber(payload.temperature_c ?? payload.temperatureC),
        humidityPercent: finiteNumber(payload.humidity_percent ?? payload.humidityPercent),
        pressureHpa: finiteNumber(payload.pressure_hpa ?? payload.pressureHpa)
      };
      continue;
    }

    if (type === "health") {
      counts.health += 1;
      latestHealth = {
        observedAt,
        uptimeSeconds: finiteNumber(payload.uptime_seconds ?? payload.uptimeSeconds),
        cpuTemperatureC: finiteNumber(payload.cpu_temperature_c ?? payload.cpuTemperatureC),
        cpuLoadPercent: finiteNumber(payload.cpu_load_percent ?? payload.cpuLoadPercent),
        diskFreePercent: finiteNumber(payload.disk_free_percent ?? payload.diskFreePercent),
        gpsFix: booleanValue(payload.gps_fix ?? payload.gpsFix),
        internetReachable: booleanValue(payload.internet_reachable ?? payload.internetReachable),
        adsbMessagesPerMinute: finiteNumber(payload.adsb_messages_per_minute ?? payload.adsbMessagesPerMinute),
        remoteIdMessagesPerMinute: finiteNumber(payload.remote_id_messages_per_minute ?? payload.remoteIdMessagesPerMinute)
      };
      continue;
    }

    counts.rejected += 1;
    warnings.push(`observation ${index} rejected: unsupported sensor observation type.`);
  }

  const trackResult =
    records.length > 0
      ? partnerAirTracks.upsert(
          {
            sourceName: "COP Sensor Node",
            sourceKind: "sensor_node",
            sensorId,
            records
          },
          now
        )
      : { accepted: 0, rejected: 0, warnings: [], stored: partnerAirTracks.stats(now).stored };

  warnings.push(...trackResult.warnings);
  sensorNodes.upsertStatus(
    sensorId,
    {
      lastSeenAt: newestTimestamp([sentAt, latestWeather?.observedAt, latestHealth?.observedAt, ...records.map((record) => record.observedAt)]),
      lastBatchAt: sentAt,
      lastLocation,
      capabilities: uniqueStrings([
        counts.adsb > 0 ? "adsb" : undefined,
        counts.remoteId > 0 ? "remote_id" : undefined,
        counts.weather > 0 ? "weather" : undefined,
        counts.health > 0 ? "health" : undefined
      ]),
      observationCounts: counts,
      latestWeather,
      latestHealth
    },
    now
  );

  return {
    accepted: trackResult.accepted + counts.weather + counts.health,
    rejected: trackResult.rejected + counts.rejected,
    trackAccepted: trackResult.accepted,
    trackRejected: trackResult.rejected,
    weatherAccepted: counts.weather,
    healthAccepted: counts.health,
    warnings,
    storedTrackCount: trackResult.stored,
    sensorStats: sensorNodes.stats(now)
  };
}

function mapAdsbObservation(
  sensorId: string,
  observation: SensorNodeObservation,
  payload: Record<string, unknown>,
  observedAt: string,
  index: number
): PartnerAirTrackIngestRecord | undefined {
  const icao24 = normalizeIcao24(asString(payload.icao24 ?? payload.hex));
  const lat = finiteNumber(payload.lat ?? payload.latitude ?? (payload.position as Record<string, unknown> | undefined)?.lat);
  const lon = finiteNumber(payload.lon ?? payload.longitude ?? (payload.position as Record<string, unknown> | undefined)?.lon);
  if (!icao24 || lat === undefined || lon === undefined) {
    return undefined;
  }
  return {
    icao24,
    callsign: cleanString(asString(payload.callsign ?? payload.flight)),
    registration: cleanString(asString(payload.registration ?? payload.r)),
    typeDesignator: cleanString(asString(payload.type_designator ?? payload.typeDesignator ?? payload.t))?.toUpperCase(),
    objectType: "AIRCRAFT",
    sourceKind: "sensor_node",
    sensorId,
    position: { lat, lon },
    altitudeM:
      finiteNumber(payload.altitude_m ?? payload.altitudeM) ??
      feetToMeters(finiteNumber(payload.altitude_ft ?? payload.altitudeFt ?? payload.alt_baro ?? payload.alt_geom)),
    speedMps:
      finiteNumber(payload.ground_speed_mps ?? payload.speed_mps ?? payload.speedMps) ??
      knotsToMps(finiteNumber(payload.ground_speed_kt ?? payload.groundSpeedKt ?? payload.gs)),
    headingDeg: finiteNumber(payload.track_deg ?? payload.trackDeg ?? payload.track ?? payload.heading_deg ?? payload.headingDeg),
    verticalRateMps:
      finiteNumber(payload.vertical_rate_mps ?? payload.verticalRateMps) ??
      feetPerMinuteToMps(finiteNumber(payload.vertical_rate_fpm ?? payload.verticalRateFpm ?? payload.baro_rate ?? payload.geom_rate)),
    onGround: booleanValue(payload.on_ground ?? payload.onGround),
    squawk: cleanString(asString(payload.squawk)),
    emergency: cleanString(asString(payload.emergency)),
    category: cleanString(asString(payload.category)),
    observedAt,
    measurement: measurementFromPayload(payload, "adsb", sensorId),
    raw: {
      observationId: observation.observation_id ?? observation.observationId ?? `adsb-${index}`,
      payload
    }
  };
}

function mapRemoteIdObservation(
  sensorId: string,
  observation: SensorNodeObservation,
  payload: Record<string, unknown>,
  observedAt: string,
  index: number
): PartnerAirTrackIngestRecord | undefined {
  const rawId = asString(payload.uas_id ?? payload.uasId ?? payload.serial_number ?? payload.serialNumber);
  const remoteId =
    cleanString(asString(payload.uas_id_hash ?? payload.uasIdHash ?? payload.remote_id ?? payload.remoteId)) ?? (rawId ? hashIdentifier(rawId) : undefined);
  const lat = finiteNumber(
    payload.lat ?? payload.latitude ?? payload.uas_lat ?? payload.uasLat ?? (payload.position as Record<string, unknown> | undefined)?.lat
  );
  const lon = finiteNumber(
    payload.lon ?? payload.longitude ?? payload.uas_lon ?? payload.uasLon ?? (payload.position as Record<string, unknown> | undefined)?.lon
  );
  if (!remoteId || lat === undefined || lon === undefined) {
    return undefined;
  }
  return {
    remoteId,
    trackId: remoteId,
    objectType: "UAV",
    sourceKind: "remote_id",
    sensorId,
    position: { lat, lon },
    altitudeM: finiteNumber(payload.alt_m ?? payload.altitude_m ?? payload.altitudeM ?? payload.height_m ?? payload.heightM),
    speedMps: finiteNumber(payload.speed_mps ?? payload.speedMps),
    headingDeg: finiteNumber(payload.track_deg ?? payload.trackDeg ?? payload.heading_deg ?? payload.headingDeg),
    verticalRateMps: finiteNumber(payload.vertical_speed_mps ?? payload.verticalSpeedMps),
    category: "B6",
    typeDesignator: "UAV",
    observedAt,
    measurement: measurementFromPayload(payload, "remote_id", sensorId),
    raw: {
      observationId: observation.observation_id ?? observation.observationId ?? `remote-id-${index}`,
      payload: sanitizedRemoteIdPayload(payload)
    }
  };
}

function measurementFromPayload(
  payload: Record<string, unknown>,
  fallbackProtocol: FlightObservationMeasurementQuality["sourceProtocol"],
  sensorId: string
): FlightObservationMeasurementQuality | undefined {
  const radio = (payload.radio && typeof payload.radio === "object" ? payload.radio : {}) as Record<string, unknown>;
  const measurement: FlightObservationMeasurementQuality = {
    sourceProtocol: normalizeProtocol(asString(radio.protocol ?? payload.protocol)) ?? fallbackProtocol,
    receiverId: sensorId,
    rssiDbm: finiteNumber(radio.rssi_dbm ?? radio.rssiDbm ?? payload.rssi_dbm ?? payload.rssiDbm),
    rssiDbfs: finiteNumber(radio.rssi_dbfs ?? radio.rssiDbfs ?? payload.rssi_dbfs ?? payload.rssiDbfs),
    messageCount: finiteNumber(radio.message_count ?? radio.messageCount ?? payload.message_count ?? payload.messageCount ?? payload.messages),
    channel: asString(radio.channel ?? payload.channel) ?? finiteNumber(radio.channel ?? payload.channel),
    frequencyMhz: finiteNumber(radio.frequency_mhz ?? radio.frequencyMhz ?? payload.frequency_mhz ?? payload.frequencyMhz),
    horizontalAccuracyM: finiteNumber(payload.horizontal_accuracy_m ?? payload.horizontalAccuracyM ?? payload.accuracy_h_m ?? payload.accuracyHM),
    verticalAccuracyM: finiteNumber(payload.vertical_accuracy_m ?? payload.verticalAccuracyM ?? payload.accuracy_v_m ?? payload.accuracyVM),
    speedAccuracyMps: finiteNumber(payload.speed_accuracy_mps ?? payload.speedAccuracyMps),
    headingAccuracyDeg: finiteNumber(payload.heading_accuracy_deg ?? payload.headingAccuracyDeg),
    receiverDistanceM: finiteNumber(payload.receiver_distance_m ?? payload.receiverDistanceM),
    nic: finiteNumber(payload.nic),
    nacP: finiteNumber(payload.nac_p ?? payload.nacP),
    nacV: finiteNumber(payload.nac_v ?? payload.nacV),
    sil: finiteNumber(payload.sil),
    sda: finiteNumber(payload.sda),
    rcM: finiteNumber(payload.rc ?? payload.rc_m ?? payload.rcM)
  };
  const cleaned = Object.fromEntries(
    Object.entries(measurement).filter(([, value]) => value !== undefined && value !== null && value !== "")
  ) as FlightObservationMeasurementQuality;
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function sanitizedRemoteIdPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const deny = new Set([
    "uas_id",
    "uasId",
    "operator_id",
    "operatorId",
    "operator_lat",
    "operatorLat",
    "operator_lon",
    "operatorLon",
    "operator_location",
    "operatorLocation",
    "pilot_lat",
    "pilotLat",
    "pilot_lon",
    "pilotLon"
  ]);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !deny.has(key)));
}

function locationFrom(value: Record<string, unknown> | undefined): SensorNodeStatus["lastLocation"] | undefined {
  if (!value) {
    return undefined;
  }
  const lat = finiteNumber(value.lat ?? value.latitude);
  const lon = finiteNumber(value.lon ?? value.longitude);
  if (lat === undefined || lon === undefined || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return undefined;
  }
  return {
    lat: round(lat, 6),
    lon: round(lon, 6),
    heightM: finiteNumber(value.height_m ?? value.heightM ?? value.altitude_m ?? value.altitudeM)
  };
}

function normalizeObservationType(value: string | undefined): "adsb" | "remote_id" | "weather" | "health" | "unknown" {
  const normalized = value?.trim().toLowerCase().replace(/[-.]/g, "_");
  if (!normalized) {
    return "unknown";
  }
  if (normalized.includes("remote_id") || normalized.includes("rid")) {
    return "remote_id";
  }
  if (normalized.includes("adsb") || normalized.includes("mode_s")) {
    return "adsb";
  }
  if (normalized.includes("weather") || normalized.includes("meteo")) {
    return "weather";
  }
  if (normalized.includes("health")) {
    return "health";
  }
  return "unknown";
}

function normalizeProtocol(value: string | undefined): FlightObservationMeasurementQuality["sourceProtocol"] | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[-.]/g, "_");
  if (!normalized) {
    return undefined;
  }
  if (["adsb", "ads_b"].includes(normalized)) {
    return "adsb";
  }
  if (["mode_s", "modes"].includes(normalized)) {
    return "mode_s";
  }
  if (["remote_id", "rid", "opendroneid"].includes(normalized)) {
    return "remote_id";
  }
  if (normalized === "mlat") {
    return "mlat";
  }
  if (normalized === "radar") {
    return "radar";
  }
  return "unknown";
}

function newestTimestamp(values: Array<string | undefined>): string {
  const newest = values
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  return new Date(newest ?? Date.now()).toISOString();
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function hashIdentifier(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function normalizeIcao24(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[0-9a-f]{6}$/.test(normalized) ? normalized : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cleanString(value: string | undefined | null): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function feetToMeters(value: number | undefined): number | undefined {
  return value === undefined ? undefined : round(value * 0.3048, 2);
}

function knotsToMps(value: number | undefined): number | undefined {
  return value === undefined ? undefined : round(value * 0.514444, 2);
}

function feetPerMinuteToMps(value: number | undefined): number | undefined {
  return value === undefined ? undefined : round(value * 0.00508, 2);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
