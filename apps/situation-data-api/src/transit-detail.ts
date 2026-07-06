import { strFromU8, unzipSync } from "fflate";
import gtfsRealtime from "gtfs-realtime-bindings";
import type { transit_realtime } from "gtfs-realtime-bindings";
import type { SituationDataConfig } from "./config.js";
import { ManagedResponseCache } from "./response-cache.js";
import {
  fetchIdsjmkVehicleFeed,
  fetchSpravaZeleznicTrainFeatures,
  idsjmkVehicleLonLat,
  normalizeIdsjmkVehicles,
  spravaZeleznicTrainLonLat,
  type IdsjmkVehicleFeed,
  type IdsjmkVehicleRecord,
  type SpravaZeleznicTrainFeature
} from "./sources.js";

type TransitSourceId = "pid_gtfs_rt" | "idsjmk_vehicle_positions" | "spravazeleznic_trains";

interface GtfsRoute {
  routeId: string;
  shortName?: string;
  longName?: string;
  type?: number;
}

interface GtfsTrip {
  tripId: string;
  routeId: string;
  serviceId?: string;
  headsign?: string;
  directionId?: string;
  shapeId?: string;
}

interface GtfsStop {
  stopId: string;
  name?: string;
  lat?: number;
  lon?: number;
}

interface GtfsStopTime {
  stopId: string;
  stopSequence: number;
  arrivalTime?: string;
  departureTime?: string;
}

interface GtfsShapePoint {
  lat: number;
  lon: number;
  sequence: number;
}

type TransitStopRelation = "previous" | "current" | "next" | "future" | "unknown";

interface TransitVehicleHistoryPoint {
  observedAt: string;
  position?: {
    lat: number;
    lon: number;
    headingDeg?: number;
    speedMps?: number;
  };
  stopId?: string;
  currentStopSequence?: number;
  relationToVehicle?: TransitStopRelation;
}

interface TransitVehiclePredictionStop {
  stopId: string;
  stopName?: string;
  stopSequence: number;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  predictedArrival?: string;
  predictedDeparture?: string;
  delaySeconds?: number;
  scheduleRelationship?: string;
  tripUpdateTimestamp?: string;
  relationToVehicle: TransitStopRelation;
  position?: {
    lat: number;
    lon: number;
  };
}

interface PidStaticModel {
  loadedAt: string;
  routes: Map<string, GtfsRoute>;
  trips: Map<string, GtfsTrip>;
  stops: Map<string, GtfsStop>;
  stopTimesText?: string;
  stopTimesHeaders?: string[];
  shapesText?: string;
  shapesHeaders?: string[];
}

interface TransitDetailOptions {
  sourceId?: string;
  includeShape?: boolean;
  maxStopTimes?: number;
  maxShapePoints?: number;
}

export interface TransitVehicleDetail {
  contractVersion: "sim-transit-vehicle-detail-v1";
  generatedAt: string;
  sourceId: TransitSourceId;
  systemId: "pid" | "idsjmk" | "spravazeleznic";
  featureId: string;
  vehicle: {
    vehicleId?: string;
    label?: string;
    transportMode: string;
    position?: {
      lat: number;
      lon: number;
      headingDeg?: number;
      speedMps?: number;
      observedAt?: string;
    };
    occupancyStatus?: string;
    occupancyPercent?: number;
    currentStatus?: string;
    currentStopSequence?: number;
    stopId?: string;
  };
  trip: {
    tripId?: string;
    routeId?: string;
    routeShortName?: string;
    routeLongName?: string;
    destination?: string;
    directionId?: string;
    startDate?: string;
    startTime?: string;
    delaySeconds?: number;
    status: "on_time" | "early" | "delayed" | "stopped" | "in_transit" | "stale" | "unknown";
  };
  stopTimes: Array<{
    stopId: string;
    stopName?: string;
    stopSequence: number;
    scheduledArrival?: string;
    scheduledDeparture?: string;
    predictedArrival?: string;
    predictedDeparture?: string;
    delaySeconds?: number;
    scheduleRelationship?: string;
    tripUpdateTimestamp?: string;
    relationToVehicle: TransitStopRelation;
    position?: {
      lat: number;
      lon: number;
    };
  }>;
  delaySeconds?: number;
  history: {
    generatedFrom: string[];
    windowSeconds: number;
    pointCount: number;
    truncated: boolean;
    points: TransitVehicleHistoryPoint[];
  };
  prediction: {
    generatedFrom: string[];
    delaySource: "official_trip_update" | "estimated_from_schedule" | "unavailable";
    delaySeconds?: number;
    tripUpdateTimestamp?: string;
    stopTimes: TransitVehiclePredictionStop[];
  };
  routeShape?: {
    shapeId: string;
    coordinates: Array<[number, number]>;
    truncated: boolean;
  };
  quality: {
    realtimeVehicleAvailable: boolean;
    staticModelAvailable: boolean;
    tripUpdateAvailable: boolean;
    tripScheduleAvailable: boolean;
    routeShapeAvailable: boolean;
    historyAvailable: boolean;
    predictionAvailable: boolean;
    generatedFrom: string[];
    warnings: string[];
  };
}

export class TransitDetailService {
  private readonly pidVehicleFeedCache: ManagedResponseCache<transit_realtime.FeedMessage>;
  private readonly pidTripUpdateFeedCache: ManagedResponseCache<transit_realtime.FeedMessage>;
  private readonly pidStaticModelCache: ManagedResponseCache<PidStaticModel>;
  private readonly idsjmkVehicleFeedCache: ManagedResponseCache<IdsjmkVehicleFeed>;
  private readonly spravaZeleznicTrainFeedCache: ManagedResponseCache<SpravaZeleznicTrainFeature[]>;
  private readonly pidVehicleHistory = new Map<string, TransitVehicleHistoryPoint[]>();
  private readonly idsjmkVehicleHistory = new Map<string, TransitVehicleHistoryPoint[]>();
  private readonly spravaZeleznicTrainHistory = new Map<string, TransitVehicleHistoryPoint[]>();
  private readonly pidHistoryWindowSeconds = 30 * 60;
  private readonly pidHistoryMaxPoints = 120;

  constructor(private readonly config: SituationDataConfig) {
    this.pidVehicleFeedCache = new ManagedResponseCache<transit_realtime.FeedMessage>({
      ttlMs: 20_000,
      staleIfErrorMs: Math.max(60_000, config.staleIfErrorSeconds * 1000),
      maxEntries: 1
    });
    this.pidTripUpdateFeedCache = new ManagedResponseCache<transit_realtime.FeedMessage>({
      ttlMs: 20_000,
      staleIfErrorMs: Math.max(60_000, config.staleIfErrorSeconds * 1000),
      maxEntries: 1
    });
    this.pidStaticModelCache = new ManagedResponseCache<PidStaticModel>({
      ttlMs: Math.max(60, config.pidGtfsStaticCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(15 * 60_000, config.staleIfErrorSeconds * 1000),
      maxEntries: 1
    });
    this.idsjmkVehicleFeedCache = new ManagedResponseCache<IdsjmkVehicleFeed>({
      ttlMs: Math.max(10, config.idsjmkVehiclePositionsCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(300, config.staleIfErrorSeconds) * 1000,
      maxEntries: 1
    });
    this.spravaZeleznicTrainFeedCache = new ManagedResponseCache<SpravaZeleznicTrainFeature[]>({
      ttlMs: Math.max(900, config.spravaZeleznicTrainPositionsCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(900, config.staleIfErrorSeconds) * 1000,
      maxEntries: 1
    });
  }

  async getVehicleDetail(featureId: string, options: TransitDetailOptions = {}): Promise<TransitVehicleDetail | undefined> {
    const sourceId = normalizeTransitSourceId(options.sourceId);
    if (sourceId === "idsjmk_vehicle_positions") {
      return this.getIdsjmkVehicleDetail(featureId);
    }
    if (sourceId === "spravazeleznic_trains") {
      return this.getSpravaZeleznicTrainDetail(featureId);
    }
    if (sourceId !== "pid_gtfs_rt") {
      return undefined;
    }

    const generatedAt = new Date().toISOString();
    const warnings: string[] = [];
    const feed = await this.pidVehicleFeedCache.getOrLoad("pid_gtfs_rt_vehicle_positions", () => fetchPidVehiclePositionFeed(this.config));
    const entity = findPidVehicleEntity(feed, featureId);
    if (!entity?.vehicle) {
      return undefined;
    }
    const history = this.recordPidVehicleHistory(entity);
    let tripUpdate: transit_realtime.ITripUpdate | undefined;
    try {
      const tripUpdateFeed = await this.pidTripUpdateFeedCache.getOrLoad("pid_gtfs_rt_trip_updates", () => fetchPidTripUpdateFeed(this.config));
      tripUpdate = findPidTripUpdate(tripUpdateFeed, entity);
      if (!tripUpdate) {
        warnings.push("PID GTFS-RT trip updates feed is available, but no matching TripUpdate was found for this vehicle.");
      }
    } catch (error) {
      warnings.push(`PID GTFS-RT trip updates are not available: ${errorMessage(error)}`);
    }

    let staticModel: PidStaticModel | undefined;
    try {
      staticModel = await this.pidStaticModelCache.getOrLoad("pid_gtfs_static", () => fetchPidStaticModel(this.config));
    } catch (error) {
      warnings.push(`PID static GTFS is not available: ${errorMessage(error)}`);
    }

    return buildPidVehicleDetail(entity, featureId, generatedAt, staticModel, tripUpdate, warnings, history, this.pidHistoryWindowSeconds, {
      includeShape: options.includeShape ?? true,
      maxStopTimes: clampInteger(options.maxStopTimes, 5, 120, 60),
      maxShapePoints: clampInteger(options.maxShapePoints, 10, 2000, 500)
    });
  }

  private recordPidVehicleHistory(entity: transit_realtime.IFeedEntity): TransitVehicleHistoryPoint[] {
    const vehicle = entity.vehicle;
    const vehicleId = optionalString(vehicle?.vehicle?.id) ?? optionalString(entity.id);
    if (!vehicleId) {
      return [];
    }
    const observedAt = observedAtForVehicle(vehicle);
    const point = historyPointFromVehicle(vehicle, observedAt);
    const key = stableToken(vehicleId);
    const existing = this.pidVehicleHistory.get(key) ?? [];
    const next = point ? appendHistoryPoint(existing, point, this.pidHistoryWindowSeconds, this.pidHistoryMaxPoints) : existing;
    this.pidVehicleHistory.set(key, next);
    return next;
  }

  private async getIdsjmkVehicleDetail(featureId: string): Promise<TransitVehicleDetail | undefined> {
    const feed = await this.idsjmkVehicleFeedCache.getOrLoad("idsjmk_vehicle_positions", () => fetchIdsjmkVehicleFeed(this.config));
    const sourceObservedAt = parseTimestamp(recordValue(feed, ["LastUpdate", "lastUpdate"])) ?? new Date().toISOString();
    const record = findIdsjmkVehicleRecord(feed, featureId, sourceObservedAt);
    if (!record) {
      return undefined;
    }
    const observedAt = idsjmkObservedAt(record, sourceObservedAt);
    return buildIdsjmkVehicleDetail(record, featureId, observedAt, this.recordExternalVehicleHistory("idsjmk", record, observedAt));
  }

  private async getSpravaZeleznicTrainDetail(featureId: string): Promise<TransitVehicleDetail | undefined> {
    const trains = await this.spravaZeleznicTrainFeedCache.getOrLoad("spravazeleznic_train_positions", () => fetchSpravaZeleznicTrainFeatures(this.config));
    const generatedAt = new Date().toISOString();
    const train = findSpravaZeleznicTrain(trains, featureId);
    if (!train) {
      return undefined;
    }
    return buildSpravaZeleznicTrainDetail(train, featureId, generatedAt, this.recordExternalVehicleHistory("spravazeleznic", train, generatedAt));
  }

  private recordExternalVehicleHistory(
    source: "idsjmk" | "spravazeleznic",
    record: IdsjmkVehicleRecord | SpravaZeleznicTrainFeature,
    observedAt: string
  ): TransitVehicleHistoryPoint[] {
    const point =
      source === "idsjmk" ? idsjmkHistoryPoint(record as IdsjmkVehicleRecord, observedAt) : trainHistoryPoint(record as SpravaZeleznicTrainFeature, observedAt);
    const vehicleId =
      source === "idsjmk" ? idsjmkVehicleId(record as IdsjmkVehicleRecord, observedAt) : spravaZeleznicTrainId(record as SpravaZeleznicTrainFeature);
    if (!point || !vehicleId) {
      return [];
    }
    const cache = source === "idsjmk" ? this.idsjmkVehicleHistory : this.spravaZeleznicTrainHistory;
    const existing = cache.get(stableToken(vehicleId)) ?? [];
    const next = appendHistoryPoint(existing, point, this.pidHistoryWindowSeconds, this.pidHistoryMaxPoints);
    cache.set(stableToken(vehicleId), next);
    return next;
  }
}

function buildPidVehicleDetail(
  entity: transit_realtime.IFeedEntity,
  featureId: string,
  generatedAt: string,
  staticModel: PidStaticModel | undefined,
  tripUpdate: transit_realtime.ITripUpdate | undefined,
  warnings: string[],
  history: TransitVehicleHistoryPoint[],
  historyWindowSeconds: number,
  options: Required<Pick<TransitDetailOptions, "includeShape" | "maxStopTimes" | "maxShapePoints">>
): TransitVehicleDetail {
  const vehicle = entity.vehicle;
  const vehicleId = optionalString(vehicle?.vehicle?.id) ?? optionalString(entity.id);
  const tripId = optionalString(vehicle?.trip?.tripId);
  const routeId = optionalString(vehicle?.trip?.routeId);
  const staticTrip = tripId ? staticModel?.trips.get(tripId) : undefined;
  const normalizedRouteId = routeId ?? staticTrip?.routeId;
  const staticRoute = normalizedRouteId ? staticModel?.routes.get(normalizedRouteId) : undefined;
  const mode = pidVehicleMode(vehicleId, normalizedRouteId, staticRoute?.type);
  const routeShortName = staticRoute?.shortName ?? pidRouteLabel(normalizedRouteId, vehicleId);
  const position = vehicle?.position;
  const observedAt = observedAtForVehicle(vehicle);
  const currentStopSequence = longToNumber(vehicle?.currentStopSequence);
  const stopTimes = tripId && staticModel ? findStopTimesForTrip(staticModel, tripId, options.maxStopTimes) : [];
  const detailedStopTimes = stopTimes.map((stopTime) => {
    const stop = staticModel?.stops.get(stopTime.stopId);
    return {
      stopId: stopTime.stopId,
      stopName: stop?.name,
      stopSequence: stopTime.stopSequence,
      scheduledArrival: stopTime.arrivalTime,
      scheduledDeparture: stopTime.departureTime,
      relationToVehicle: stopRelation(stopTime.stopSequence, currentStopSequence),
      position:
        stop?.lat !== undefined && stop.lon !== undefined
          ? {
              lat: stop.lat,
              lon: stop.lon
            }
          : undefined
    };
  });
  const estimatedDelaySeconds = estimateDelaySeconds(vehicle, detailedStopTimes, observedAt);
  const officialDelaySeconds = tripUpdateDelaySeconds(tripUpdate, currentStopSequence, optionalString(vehicle?.stopId));
  const delaySeconds = officialDelaySeconds ?? estimatedDelaySeconds;
  const prediction = buildPrediction(
    detailedStopTimes,
    optionalString(vehicle?.trip?.startDate) ?? optionalString(tripUpdate?.trip?.startDate),
    estimatedDelaySeconds,
    tripUpdate
  );
  const qualityWarnings = [...warnings];
  if (!tripUpdate && delaySeconds === undefined) {
    qualityWarnings.push(
      "PID GTFS-RT trip update is unavailable for this vehicle; delay is unavailable unless SIM can estimate it from current stop schedule."
    );
  }
  const shape =
    options.includeShape && staticModel && staticTrip?.shapeId ? findShapeForTrip(staticModel, staticTrip.shapeId, options.maxShapePoints) : undefined;

  return {
    contractVersion: "sim-transit-vehicle-detail-v1",
    generatedAt,
    sourceId: "pid_gtfs_rt",
    systemId: "pid",
    featureId,
    vehicle: {
      vehicleId,
      label: optionalString(vehicle?.vehicle?.label),
      transportMode: mode,
      position:
        position?.latitude !== undefined && position.longitude !== undefined
          ? {
              lat: Number(position.latitude),
              lon: Number(position.longitude),
              headingDeg: optionalNumber(position.bearing),
              speedMps: optionalNumber(position.speed),
              observedAt
            }
          : undefined,
      occupancyStatus: pidOccupancyStatus(vehicle?.occupancyStatus),
      occupancyPercent: optionalNumber(vehicle?.occupancyPercentage),
      currentStatus: pidVehicleStopStatus(vehicle?.currentStatus),
      currentStopSequence,
      stopId: optionalString(vehicle?.stopId)
    },
    trip: {
      tripId,
      routeId: normalizedRouteId,
      routeShortName,
      routeLongName: staticRoute?.longName,
      destination: staticTrip?.headsign,
      directionId: staticTrip?.directionId,
      startDate: optionalString(vehicle?.trip?.startDate),
      startTime: optionalString(vehicle?.trip?.startTime),
      delaySeconds,
      status: transitTripStatus(vehicle?.currentStatus, observedAt, delaySeconds)
    },
    stopTimes: prediction.stopTimes,
    delaySeconds,
    history: {
      generatedFrom: history.length > 0 ? ["pid_gtfs_rt_vehicle_positions", "sim_in_memory_vehicle_history"] : ["pid_gtfs_rt_vehicle_positions"],
      windowSeconds: historyWindowSeconds,
      pointCount: history.length,
      truncated: history.length >= 120,
      points: history
    },
    prediction,
    routeShape: shape
      ? {
          shapeId: shape.shapeId,
          coordinates: shape.points.map((point) => [point.lon, point.lat]),
          truncated: shape.truncated
        }
      : undefined,
    quality: {
      realtimeVehicleAvailable: true,
      staticModelAvailable: Boolean(staticModel),
      tripUpdateAvailable: Boolean(tripUpdate),
      tripScheduleAvailable: detailedStopTimes.length > 0,
      routeShapeAvailable: Boolean(shape),
      historyAvailable: history.length > 0,
      predictionAvailable: prediction.stopTimes.length > 0,
      generatedFrom: [
        "pid_gtfs_rt_vehicle_positions",
        ...(tripUpdate ? ["pid_gtfs_rt_trip_updates"] : []),
        ...(staticModel ? ["pid_static_gtfs"] : []),
        ...(tripUpdate ? [] : staticModel ? ["pid_static_schedule_prediction"] : [])
      ],
      warnings: qualityWarnings
    }
  };
}

function buildIdsjmkVehicleDetail(
  record: IdsjmkVehicleRecord,
  featureId: string,
  sourceObservedAt: string,
  history: TransitVehicleHistoryPoint[]
): TransitVehicleDetail {
  const generatedAt = new Date().toISOString();
  const position = idsjmkVehicleLonLat(record);
  const vehicleId = idsjmkVehicleId(record, sourceObservedAt);
  const routeType = numberFromRecord(record, ["routeType", "RouteType", "route_type", "gtfsRouteType"]);
  const mode = idsjmkVehicleMode(record, routeType);
  const routeId = stringFromRecord(record, ["routeId", "RouteId", "route_id"]);
  const routeShortName = stringFromRecord(record, [
    "line",
    "Line",
    "lineName",
    "LineName",
    "linename",
    "LineID",
    "lineid",
    "lineNumber",
    "LineNumber",
    "route",
    "Route",
    "routeId",
    "RouteId"
  ]);
  const tripId = stringFromRecord(record, ["tripId", "TripId", "trip_id", "course", "Course", "routeId", "RouteId"]);
  const destination = stringFromRecord(record, [
    "destination",
    "Destination",
    "headsign",
    "Headsign",
    "tripHeadsign",
    "TripHeadsign",
    "FinalStopID",
    "finalstopid"
  ]);
  const operator = stringFromRecord(record, ["operator", "Operator", "agency", "Agency"]) ?? "IDS JMK";
  const headingDeg = numberFromRecord(record, ["bearing", "Bearing", "heading", "Heading", "azimuth", "Azimuth"]);
  const speedMps = numberFromRecord(record, ["speed", "Speed", "speedMps", "SpeedMps", "velocity", "Velocity"]);
  const delaySeconds = numberFromRecord(record, ["delay", "Delay", "delaySeconds", "DelaySeconds"]);
  const currentStopSequence = numberFromRecord(record, ["currentStopSequence", "CurrentStopSequence", "stopSequence", "StopSequence"]);
  const stopId = stringFromRecord(record, ["stopId", "StopId", "stop_id", "nextStopId", "NextStopId"]);
  const qualityWarnings = [
    "IDS JMK detail is generated from the live position feed. Complete stop sequence and route shape require a stable match to the static GTFS trip model."
  ];
  const generatedFrom = ["idsjmk_vehicle_positions", ...(history.length > 0 ? ["sim_in_memory_vehicle_history"] : [])];

  return {
    contractVersion: "sim-transit-vehicle-detail-v1",
    generatedAt,
    sourceId: "idsjmk_vehicle_positions",
    systemId: "idsjmk",
    featureId,
    vehicle: {
      vehicleId,
      label: routeShortName ? `${mode.label} ${routeShortName}` : mode.label,
      transportMode: mode.transportMode,
      position: position
        ? {
            lat: position.lat,
            lon: position.lon,
            headingDeg,
            speedMps,
            observedAt: sourceObservedAt
          }
        : undefined,
      currentStopSequence,
      stopId
    },
    trip: {
      tripId,
      routeId,
      routeShortName,
      destination,
      delaySeconds,
      status: externalTransitStatus(sourceObservedAt, delaySeconds)
    },
    stopTimes: [],
    delaySeconds,
    history: {
      generatedFrom,
      windowSeconds: 30 * 60,
      pointCount: history.length,
      truncated: history.length >= 120,
      points: history
    },
    prediction: {
      generatedFrom: ["idsjmk_vehicle_positions"],
      delaySource: delaySeconds === undefined ? "unavailable" : "estimated_from_schedule",
      delaySeconds,
      stopTimes: []
    },
    quality: {
      realtimeVehicleAvailable: Boolean(position),
      staticModelAvailable: false,
      tripUpdateAvailable: delaySeconds !== undefined,
      tripScheduleAvailable: false,
      routeShapeAvailable: false,
      historyAvailable: history.length > 0,
      predictionAvailable: delaySeconds !== undefined,
      generatedFrom,
      warnings: qualityWarnings
    }
  };
}

function buildSpravaZeleznicTrainDetail(
  train: SpravaZeleznicTrainFeature,
  featureId: string,
  generatedAt: string,
  history: TransitVehicleHistoryPoint[]
): TransitVehicleDetail {
  const props = train.properties ?? {};
  const position = spravaZeleznicTrainLonLat(train.geometry?.coordinates);
  const vehicleId = spravaZeleznicTrainId(train);
  const trainType = optionalString(props.tt);
  const trainNumber = optionalString(props.tn);
  const trainName = optionalString(props.na);
  const routeShortName = [trainType, trainNumber].filter(Boolean).join(" ") || trainNumber || trainName;
  const origin = optionalString(props.fn);
  const destination = optionalString(props.ln);
  const operator = optionalString(props.d);
  const currentStationName = optionalString(props.cna);
  const nextStationName = optionalString(props.nsn);
  const plannedTime = optionalString(props.cp);
  const currentTime = optionalString(props.cr);
  const nextScheduledTime = optionalString(props.nst);
  const nextPredictedTime = optionalString(props.nsp);
  const delayMinutes = optionalNumber(props.de);
  const delaySeconds = delayMinutes === undefined ? undefined : Math.round(delayMinutes * 60);
  const headingDeg = optionalNumber(props.a);
  const stopTimes = trainStopTimes({
    currentStationName,
    nextStationName,
    plannedTime,
    currentTime,
    nextScheduledTime,
    nextPredictedTime,
    delaySeconds
  });
  const generatedFrom = ["spravazeleznic_trains", ...(history.length > 0 ? ["sim_in_memory_vehicle_history"] : [])];
  const qualityWarnings = [
    "Správa železnic live map feed provides current and next station context, but SIM does not yet have a stable full railway route shape/static stop sequence model."
  ];

  return {
    contractVersion: "sim-transit-vehicle-detail-v1",
    generatedAt,
    sourceId: "spravazeleznic_trains",
    systemId: "spravazeleznic",
    featureId,
    vehicle: {
      vehicleId,
      label: routeShortName ? `Vlak ${routeShortName}` : "Vlak Správy železnic",
      transportMode: "train",
      position: position
        ? {
            lat: position.lat,
            lon: position.lon,
            headingDeg,
            observedAt: generatedAt
          }
        : undefined
    },
    trip: {
      tripId: vehicleId,
      routeShortName,
      routeLongName: trainName,
      destination,
      delaySeconds,
      status: externalTransitStatus(generatedAt, delaySeconds)
    },
    stopTimes,
    delaySeconds,
    history: {
      generatedFrom,
      windowSeconds: 30 * 60,
      pointCount: history.length,
      truncated: history.length >= 120,
      points: history
    },
    prediction: {
      generatedFrom: ["spravazeleznic_trains"],
      delaySource: stopTimes.length === 0 && delaySeconds === undefined ? "unavailable" : "estimated_from_schedule",
      delaySeconds,
      stopTimes
    },
    quality: {
      realtimeVehicleAvailable: Boolean(position),
      staticModelAvailable: false,
      tripUpdateAvailable: delaySeconds !== undefined || nextPredictedTime !== undefined,
      tripScheduleAvailable: stopTimes.length > 0,
      routeShapeAvailable: false,
      historyAvailable: history.length > 0,
      predictionAvailable: stopTimes.length > 0 || delaySeconds !== undefined,
      generatedFrom,
      warnings: qualityWarnings
    }
  };
}

function observedAtForVehicle(vehicle: transit_realtime.IVehiclePosition | null | undefined): string | undefined {
  const timestamp = longToNumber(vehicle?.timestamp);
  return timestamp && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : undefined;
}

function findIdsjmkVehicleRecord(feed: IdsjmkVehicleFeed, featureId: string, sourceObservedAt: string): IdsjmkVehicleRecord | undefined {
  const normalizedFeatureId = decodeURIComponent(featureId);
  return normalizeIdsjmkVehicles(feed).find((record) => {
    const vehicleId = idsjmkVehicleId(record, sourceObservedAt);
    return vehicleId ? `traffic:idsjmk_vehicle_positions:${stableToken(vehicleId)}` === normalizedFeatureId : false;
  });
}

function findSpravaZeleznicTrain(trains: SpravaZeleznicTrainFeature[], featureId: string): SpravaZeleznicTrainFeature | undefined {
  const normalizedFeatureId = decodeURIComponent(featureId);
  return trains.find((train) => {
    const trainId = spravaZeleznicTrainId(train);
    return trainId ? `traffic:spravazeleznic_trains:${stableToken(trainId)}` === normalizedFeatureId : false;
  });
}

function idsjmkHistoryPoint(record: IdsjmkVehicleRecord, observedAt: string): TransitVehicleHistoryPoint | undefined {
  const position = idsjmkVehicleLonLat(record);
  return {
    observedAt,
    position: position
      ? {
          lat: position.lat,
          lon: position.lon,
          headingDeg: numberFromRecord(record, ["bearing", "Bearing", "heading", "Heading", "azimuth", "Azimuth"]),
          speedMps: numberFromRecord(record, ["speed", "Speed", "speedMps", "SpeedMps", "velocity", "Velocity"])
        }
      : undefined,
    stopId: stringFromRecord(record, ["stopId", "StopId", "stop_id", "nextStopId", "NextStopId"]),
    currentStopSequence: numberFromRecord(record, ["currentStopSequence", "CurrentStopSequence", "stopSequence", "StopSequence"]),
    relationToVehicle: "unknown"
  };
}

function trainHistoryPoint(train: SpravaZeleznicTrainFeature, observedAt: string): TransitVehicleHistoryPoint | undefined {
  const position = spravaZeleznicTrainLonLat(train.geometry?.coordinates);
  const props = train.properties ?? {};
  return {
    observedAt,
    position: position
      ? {
          lat: position.lat,
          lon: position.lon,
          headingDeg: optionalNumber(props.a)
        }
      : undefined,
    stopId: optionalString(props.cna) ? stableToken(`current:${optionalString(props.cna)}`) : undefined,
    relationToVehicle: "current"
  };
}

function idsjmkVehicleId(record: IdsjmkVehicleRecord, observedAt: string): string | undefined {
  const position = idsjmkVehicleLonLat(record);
  return (
    stringFromRecord(record, [
      "vehicleId",
      "VehicleId",
      "vehicle_id",
      "globalid",
      "GlobalID",
      "id",
      "Id",
      "ID",
      "objectId",
      "OBJECTID",
      "vehicle",
      "Vehicle"
    ]) ?? (position ? stableToken(`${position.lon}:${position.lat}:${observedAt}`) : undefined)
  );
}

function idsjmkObservedAt(record: IdsjmkVehicleRecord, sourceObservedAt: string): string {
  return (
    parseTimestamp(
      recordValue(record, [
        "lastUpdate",
        "LastUpdate",
        "lastupdate",
        "TimeUpdated",
        "last_update",
        "timestamp",
        "Timestamp",
        "time",
        "Time",
        "updatedAt",
        "UpdatedAt"
      ])
    ) ?? sourceObservedAt
  );
}

function spravaZeleznicTrainId(train: SpravaZeleznicTrainFeature): string | undefined {
  const position = spravaZeleznicTrainLonLat(train.geometry?.coordinates);
  const props = train.properties ?? {};
  return optionalString(props.id) ?? optionalString(train.id) ?? (position ? `${position.lon}:${position.lat}` : undefined);
}

function trainStopTimes(input: {
  currentStationName?: string;
  nextStationName?: string;
  plannedTime?: string;
  currentTime?: string;
  nextScheduledTime?: string;
  nextPredictedTime?: string;
  delaySeconds?: number;
}): TransitVehicleDetail["stopTimes"] {
  const stopTimes: TransitVehicleDetail["stopTimes"] = [];
  if (input.currentStationName) {
    stopTimes.push({
      stopId: stableToken(`current:${input.currentStationName}`),
      stopName: input.currentStationName,
      stopSequence: 0,
      scheduledDeparture: input.plannedTime,
      predictedDeparture: input.currentTime,
      delaySeconds: input.delaySeconds,
      relationToVehicle: "current"
    });
  }
  if (input.nextStationName) {
    stopTimes.push({
      stopId: stableToken(`next:${input.nextStationName}`),
      stopName: input.nextStationName,
      stopSequence: stopTimes.length,
      scheduledArrival: input.nextScheduledTime,
      predictedArrival: input.nextPredictedTime,
      delaySeconds: input.delaySeconds,
      relationToVehicle: "next"
    });
  }
  return stopTimes;
}

function historyPointFromVehicle(
  vehicle: transit_realtime.IVehiclePosition | null | undefined,
  observedAt: string | undefined
): TransitVehicleHistoryPoint | undefined {
  if (!observedAt) {
    return undefined;
  }
  const position = vehicle?.position;
  const lat = optionalNumber(position?.latitude);
  const lon = optionalNumber(position?.longitude);
  return {
    observedAt,
    position:
      lat !== undefined && lon !== undefined
        ? {
            lat,
            lon,
            headingDeg: optionalNumber(position?.bearing),
            speedMps: optionalNumber(position?.speed)
          }
        : undefined,
    stopId: optionalString(vehicle?.stopId),
    currentStopSequence: longToNumber(vehicle?.currentStopSequence),
    relationToVehicle: relationFromVehicleStatus(vehicle?.currentStatus)
  };
}

function appendHistoryPoint(
  existing: TransitVehicleHistoryPoint[],
  point: TransitVehicleHistoryPoint,
  windowSeconds: number,
  maxPoints: number
): TransitVehicleHistoryPoint[] {
  const duplicate = existing.some(
    (item) => item.observedAt === point.observedAt && item.position?.lat === point.position?.lat && item.position?.lon === point.position?.lon
  );
  const withPoint = duplicate ? existing : [...existing, point];
  const cutoff = Date.parse(point.observedAt) - windowSeconds * 1000;
  return withPoint
    .filter((item) => Date.parse(item.observedAt) >= cutoff)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
    .slice(-maxPoints);
}

function estimateDelaySeconds(
  vehicle: transit_realtime.IVehiclePosition | null | undefined,
  stopTimes: TransitVehicleDetail["stopTimes"],
  observedAt: string | undefined
): number | undefined {
  const startDate = optionalString(vehicle?.trip?.startDate);
  const currentStopSequence = longToNumber(vehicle?.currentStopSequence);
  if (!startDate || currentStopSequence === undefined || !observedAt) {
    return undefined;
  }
  const currentStop = stopTimes.find((stopTime) => stopTime.stopSequence === currentStopSequence);
  const scheduledTime = currentStop?.scheduledArrival ?? currentStop?.scheduledDeparture;
  const scheduledAt = gtfsServiceTimeToIso(startDate, scheduledTime, 0);
  if (!scheduledAt) {
    return undefined;
  }
  return Math.round((Date.parse(observedAt) - Date.parse(scheduledAt)) / 1000);
}

function buildPrediction(
  stopTimes: TransitVehicleDetail["stopTimes"],
  startDate: string | undefined,
  estimatedDelaySeconds: number | undefined,
  tripUpdate: transit_realtime.ITripUpdate | undefined
): TransitVehicleDetail["prediction"] {
  const tripUpdateTimestamp = tripUpdateTimestampIso(tripUpdate);
  const tripUpdateDelay = optionalNumber(tripUpdate?.delay);
  if (tripUpdate) {
    const predictedStopTimes = stopTimes.map((stopTime) => {
      const stopUpdate = matchingStopTimeUpdate(tripUpdate, stopTime);
      const arrivalDelay = optionalNumber(stopUpdate?.arrival?.delay);
      const departureDelay = optionalNumber(stopUpdate?.departure?.delay);
      const stopDelay = departureDelay ?? arrivalDelay ?? tripUpdateDelay;
      return {
        ...stopTime,
        predictedArrival: stopTimeEventIso(stopUpdate?.arrival) ?? gtfsServiceTimeToIso(startDate, stopTime.scheduledArrival, arrivalDelay ?? stopDelay),
        predictedDeparture:
          stopTimeEventIso(stopUpdate?.departure) ?? gtfsServiceTimeToIso(startDate, stopTime.scheduledDeparture, departureDelay ?? stopDelay),
        delaySeconds: stopDelay,
        scheduleRelationship: stopTimeScheduleRelationship(stopUpdate?.scheduleRelationship),
        tripUpdateTimestamp
      };
    });
    return {
      generatedFrom: ["pid_static_gtfs", "pid_gtfs_rt_trip_updates"],
      delaySource: "official_trip_update",
      delaySeconds: tripUpdateDelaySecondsFromStops(predictedStopTimes) ?? tripUpdateDelay,
      tripUpdateTimestamp,
      stopTimes: predictedStopTimes
    };
  }

  const delaySource = estimatedDelaySeconds === undefined ? "unavailable" : "estimated_from_schedule";
  return {
    generatedFrom: estimatedDelaySeconds === undefined ? ["pid_static_gtfs"] : ["pid_static_gtfs", "pid_gtfs_rt_vehicle_position"],
    delaySource,
    delaySeconds: estimatedDelaySeconds,
    stopTimes: stopTimes.map((stopTime) => ({
      ...stopTime,
      predictedArrival: gtfsServiceTimeToIso(startDate, stopTime.scheduledArrival, estimatedDelaySeconds),
      predictedDeparture: gtfsServiceTimeToIso(startDate, stopTime.scheduledDeparture, estimatedDelaySeconds),
      delaySeconds: estimatedDelaySeconds
    }))
  };
}

function matchingStopTimeUpdate(
  tripUpdate: transit_realtime.ITripUpdate | undefined,
  stopTime: Pick<TransitVehiclePredictionStop, "stopId" | "stopSequence">
): transit_realtime.TripUpdate.IStopTimeUpdate | undefined {
  const updates = tripUpdate?.stopTimeUpdate ?? [];
  return (
    updates.find((update) => optionalNumber(update.stopSequence) === stopTime.stopSequence) ??
    updates.find((update) => optionalString(update.stopId) === stopTime.stopId)
  );
}

function tripUpdateDelaySeconds(
  tripUpdate: transit_realtime.ITripUpdate | undefined,
  currentStopSequence: number | undefined,
  stopId: string | undefined
): number | undefined {
  if (!tripUpdate) {
    return undefined;
  }
  const currentUpdate =
    currentStopSequence !== undefined
      ? (tripUpdate.stopTimeUpdate ?? []).find((update) => optionalNumber(update.stopSequence) === currentStopSequence)
      : undefined;
  const stopUpdate = currentUpdate ?? (stopId ? (tripUpdate.stopTimeUpdate ?? []).find((update) => optionalString(update.stopId) === stopId) : undefined);
  return optionalNumber(stopUpdate?.departure?.delay) ?? optionalNumber(stopUpdate?.arrival?.delay) ?? optionalNumber(tripUpdate.delay);
}

function tripUpdateDelaySecondsFromStops(stopTimes: TransitVehiclePredictionStop[]): number | undefined {
  const current = stopTimes.find((stopTime) => stopTime.relationToVehicle === "current");
  const next = stopTimes.find((stopTime) => stopTime.relationToVehicle === "next");
  return current?.delaySeconds ?? next?.delaySeconds ?? stopTimes.find((stopTime) => stopTime.delaySeconds !== undefined)?.delaySeconds;
}

function tripUpdateTimestampIso(tripUpdate: transit_realtime.ITripUpdate | undefined): string | undefined {
  const timestamp = longToNumber(tripUpdate?.timestamp);
  return timestamp && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : undefined;
}

function stopTimeEventIso(event: transit_realtime.TripUpdate.IStopTimeEvent | null | undefined): string | undefined {
  const timestamp = longToNumber(event?.time);
  return timestamp && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : undefined;
}

function stopTimeScheduleRelationship(value: transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship | null | undefined): string | undefined {
  switch (value) {
    case gtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED:
      return "skipped";
    case gtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.NO_DATA:
      return "no_data";
    case gtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.UNSCHEDULED:
      return "unscheduled";
    case gtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SCHEDULED:
      return "scheduled";
    default:
      return undefined;
  }
}

function gtfsServiceTimeToIso(serviceDate: string | undefined, time: string | undefined, delaySeconds: number | undefined): string | undefined {
  if (!serviceDate || !time) {
    return undefined;
  }
  const dateMatch = serviceDate.match(/^(\d{4})(\d{2})(\d{2})$/);
  const timeMatch = time.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) {
    return undefined;
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const seconds = Number(timeMatch[3]);
  if (![year, month, day, hours, minutes, seconds].every(Number.isFinite)) {
    return undefined;
  }
  const totalSeconds = hours * 3600 + minutes * 60 + seconds + (delaySeconds ?? 0);
  const localAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0) + totalSeconds * 1000;
  const offsetMs = timeZoneOffsetMs("Europe/Prague", new Date(localAsUtc));
  return new Date(localAsUtc - offsetMs).toISOString();
}

function timeZoneOffsetMs(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return asUtc - date.getTime();
}

async function fetchPidVehiclePositionFeed(config: SituationDataConfig): Promise<transit_realtime.FeedMessage> {
  const payload = await requestBytes(config.pidGtfsRtVehiclePositionsUrl, config.requestTimeoutMs, {
    accept: "application/x-protobuf,application/octet-stream;q=0.9,*/*;q=0.5"
  });
  return gtfsRealtime.transit_realtime.FeedMessage.decode(payload);
}

async function fetchPidTripUpdateFeed(config: SituationDataConfig): Promise<transit_realtime.FeedMessage> {
  const payload = await requestBytes(config.pidGtfsRtTripUpdatesUrl, config.requestTimeoutMs, {
    accept: "application/x-protobuf,application/octet-stream;q=0.9,*/*;q=0.5"
  });
  return gtfsRealtime.transit_realtime.FeedMessage.decode(payload);
}

async function fetchPidStaticModel(config: SituationDataConfig): Promise<PidStaticModel> {
  const archive = await requestBytes(config.pidGtfsStaticUrl, Math.max(config.requestTimeoutMs, 15_000), {
    accept: "application/zip,application/octet-stream;q=0.9,*/*;q=0.5"
  });
  const files = unzipSync(archive);
  const routesText = readGtfsText(files, "routes.txt");
  const tripsText = readGtfsText(files, "trips.txt");
  const stopsText = readGtfsText(files, "stops.txt");
  const stopTimesText = readOptionalGtfsText(files, "stop_times.txt");
  const shapesText = readOptionalGtfsText(files, "shapes.txt");
  return {
    loadedAt: new Date().toISOString(),
    routes: parseRoutes(routesText),
    trips: parseTrips(tripsText),
    stops: parseStops(stopsText),
    stopTimesText,
    stopTimesHeaders: stopTimesText ? parseCsvHeader(stopTimesText) : undefined,
    shapesText,
    shapesHeaders: shapesText ? parseCsvHeader(shapesText) : undefined
  };
}

function findPidVehicleEntity(feed: transit_realtime.FeedMessage, featureId: string): transit_realtime.IFeedEntity | undefined {
  const normalizedFeatureId = decodeURIComponent(featureId);
  for (const entity of feed.entity ?? []) {
    const vehicleId = optionalString(entity.vehicle?.vehicle?.id) ?? optionalString(entity.id);
    if (!vehicleId) {
      continue;
    }
    if (`traffic:pid_gtfs_rt:${stableToken(vehicleId)}` === normalizedFeatureId) {
      return entity;
    }
  }
  return undefined;
}

function findPidTripUpdate(feed: transit_realtime.FeedMessage, vehicleEntity: transit_realtime.IFeedEntity): transit_realtime.ITripUpdate | undefined {
  const vehicle = vehicleEntity.vehicle;
  const tripId = optionalString(vehicle?.trip?.tripId);
  const routeId = optionalString(vehicle?.trip?.routeId);
  const startDate = optionalString(vehicle?.trip?.startDate);
  const startTime = optionalString(vehicle?.trip?.startTime);
  const vehicleId = optionalString(vehicle?.vehicle?.id) ?? optionalString(vehicleEntity.id);
  const updates = (feed.entity ?? []).map((entity) => entity.tripUpdate).filter((update): update is transit_realtime.ITripUpdate => Boolean(update));

  const vehicleMatch = updates.find((update) => vehicleId !== undefined && optionalString(update.vehicle?.id) === vehicleId);
  const exactTripMatch = tripId ? updates.find((update) => tripMatches(update, { tripId, routeId, startDate, startTime })) : undefined;
  const tripIdMatch = tripId ? updates.find((update) => optionalString(update.trip?.tripId) === tripId) : undefined;
  return exactTripMatch ?? vehicleMatch ?? tripIdMatch;
}

function tripMatches(update: transit_realtime.ITripUpdate, trip: { tripId?: string; routeId?: string; startDate?: string; startTime?: string }): boolean {
  if (trip.tripId && optionalString(update.trip?.tripId) !== trip.tripId) {
    return false;
  }
  if (trip.routeId && optionalString(update.trip?.routeId) !== trip.routeId) {
    return false;
  }
  if (trip.startDate && optionalString(update.trip?.startDate) !== trip.startDate) {
    return false;
  }
  if (trip.startTime && optionalString(update.trip?.startTime) !== trip.startTime) {
    return false;
  }
  return Boolean(trip.tripId || trip.routeId || trip.startDate || trip.startTime);
}

function parseRoutes(text: string): Map<string, GtfsRoute> {
  const records = parseCsvRecords(text);
  const routes = new Map<string, GtfsRoute>();
  for (const record of records) {
    const routeId = record.route_id;
    if (!routeId) {
      continue;
    }
    routes.set(routeId, {
      routeId,
      shortName: emptyToUndefined(record.route_short_name),
      longName: emptyToUndefined(record.route_long_name),
      type: optionalNumber(record.route_type)
    });
  }
  return routes;
}

function parseTrips(text: string): Map<string, GtfsTrip> {
  const records = parseCsvRecords(text);
  const trips = new Map<string, GtfsTrip>();
  for (const record of records) {
    const tripId = record.trip_id;
    const routeId = record.route_id;
    if (!tripId || !routeId) {
      continue;
    }
    trips.set(tripId, {
      tripId,
      routeId,
      serviceId: emptyToUndefined(record.service_id),
      headsign: emptyToUndefined(record.trip_headsign),
      directionId: emptyToUndefined(record.direction_id),
      shapeId: emptyToUndefined(record.shape_id)
    });
  }
  return trips;
}

function parseStops(text: string): Map<string, GtfsStop> {
  const records = parseCsvRecords(text);
  const stops = new Map<string, GtfsStop>();
  for (const record of records) {
    const stopId = record.stop_id;
    if (!stopId) {
      continue;
    }
    stops.set(stopId, {
      stopId,
      name: emptyToUndefined(record.stop_name),
      lat: optionalNumber(record.stop_lat),
      lon: optionalNumber(record.stop_lon)
    });
  }
  return stops;
}

function findStopTimesForTrip(model: PidStaticModel, tripId: string, limit: number): GtfsStopTime[] {
  if (!model.stopTimesText || !model.stopTimesHeaders) {
    return [];
  }
  const indexes = headerIndexes(model.stopTimesHeaders);
  if (indexes.trip_id === undefined || indexes.stop_id === undefined || indexes.stop_sequence === undefined) {
    return [];
  }
  const tripIdIndex = indexes.trip_id;
  const stopIdIndex = indexes.stop_id;
  const stopSequenceIndex = indexes.stop_sequence;
  const stopTimes: GtfsStopTime[] = [];
  forEachCsvRecord(model.stopTimesText, model.stopTimesHeaders, (fields) => {
    if (fields[tripIdIndex] !== tripId) {
      return;
    }
    const stopId = fields[stopIdIndex];
    const sequence = optionalNumber(fields[stopSequenceIndex]);
    if (!stopId || sequence === undefined) {
      return;
    }
    stopTimes.push({
      stopId,
      stopSequence: sequence,
      arrivalTime: indexes.arrival_time !== undefined ? emptyToUndefined(fields[indexes.arrival_time]) : undefined,
      departureTime: indexes.departure_time !== undefined ? emptyToUndefined(fields[indexes.departure_time]) : undefined
    });
  });
  return stopTimes.sort((left, right) => left.stopSequence - right.stopSequence).slice(0, limit);
}

function findShapeForTrip(
  model: PidStaticModel,
  shapeId: string,
  limit: number
): { shapeId: string; points: GtfsShapePoint[]; truncated: boolean } | undefined {
  if (!model.shapesText || !model.shapesHeaders) {
    return undefined;
  }
  const indexes = headerIndexes(model.shapesHeaders);
  if (indexes.shape_id === undefined || indexes.shape_pt_lat === undefined || indexes.shape_pt_lon === undefined) {
    return undefined;
  }
  const shapeIdIndex = indexes.shape_id;
  const latIndex = indexes.shape_pt_lat;
  const lonIndex = indexes.shape_pt_lon;
  const points: GtfsShapePoint[] = [];
  let matchedCount = 0;
  forEachCsvRecord(model.shapesText, model.shapesHeaders, (fields) => {
    if (fields[shapeIdIndex] !== shapeId) {
      return;
    }
    matchedCount += 1;
    if (points.length >= limit) {
      return;
    }
    const lat = optionalNumber(fields[latIndex]);
    const lon = optionalNumber(fields[lonIndex]);
    if (lat === undefined || lon === undefined) {
      return;
    }
    points.push({
      lat,
      lon,
      sequence: indexes.shape_pt_sequence !== undefined ? (optionalNumber(fields[indexes.shape_pt_sequence]) ?? matchedCount) : matchedCount
    });
  });
  if (points.length === 0) {
    return undefined;
  }
  return {
    shapeId,
    points: points.sort((left, right) => left.sequence - right.sequence),
    truncated: matchedCount > points.length
  };
}

function parseCsvRecords(text: string): Array<Record<string, string>> {
  const rows = parseCsvRows(text);
  const header = rows.shift();
  if (!header) {
    return [];
  }
  return rows.map((row) => rowToRecord(header, row));
}

function parseCsvHeader(text: string): string[] | undefined {
  const firstLine = text.split(/\r?\n/, 1)[0];
  if (!firstLine) {
    return undefined;
  }
  return parseCsvLine(firstLine);
}

function forEachCsvRecord(text: string, header: string[], callback: (fields: string[]) => void): void {
  let lineNumber = 0;
  for (const line of text.split(/\r?\n/)) {
    if (lineNumber === 0) {
      lineNumber += 1;
      continue;
    }
    lineNumber += 1;
    if (!line.trim()) {
      continue;
    }
    callback(parseCsvLine(line));
  }
}

function parseCsvRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parseCsvLine);
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      fields.push(field);
      field = "";
      continue;
    }
    field += char;
  }
  fields.push(field);
  return fields;
}

function rowToRecord(header: string[], row: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  header.forEach((name, index) => {
    record[name] = row[index] ?? "";
  });
  return record;
}

function headerIndexes(headers: string[]): Record<string, number | undefined> {
  const indexes: Record<string, number | undefined> = {};
  headers.forEach((name, index) => {
    indexes[name] = index;
  });
  return indexes;
}

function readGtfsText(files: Record<string, Uint8Array>, name: string): string {
  const text = readOptionalGtfsText(files, name);
  if (!text) {
    throw new Error(`GTFS archive does not contain ${name}.`);
  }
  return text;
}

function readOptionalGtfsText(files: Record<string, Uint8Array>, name: string): string | undefined {
  const entry = Object.entries(files).find(([path]) => path === name || path.endsWith(`/${name}`));
  return entry ? strFromU8(entry[1]) : undefined;
}

async function requestBytes(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function pidVehicleMode(vehicleId: string | undefined, routeId: string | undefined, routeType: number | undefined): string {
  if (routeType !== undefined) {
    return pidModeFromRouteType(routeType);
  }
  const normalizedVehicleId = vehicleId?.toLowerCase() ?? "";
  const serviceMatch = normalizedVehicleId.match(/^service-(\d+)-/);
  if (serviceMatch?.[1]) {
    return pidModeFromRouteType(Number(serviceMatch[1]));
  }
  if (normalizedVehicleId.startsWith("metro-") || /^L?[ABC]$/i.test(routeId ?? "")) {
    return "metro";
  }
  if (normalizedVehicleId.startsWith("train-")) {
    return "train";
  }
  if (normalizedVehicleId.startsWith("tram-")) {
    return "tram";
  }
  return "bus";
}

function pidModeFromRouteType(routeTypeCode: number): string {
  switch (routeTypeCode) {
    case 0:
      return "tram";
    case 1:
      return "metro";
    case 2:
      return "train";
    case 11:
      return "trolleybus";
    case 3:
    default:
      return "bus";
  }
}

function idsjmkVehicleMode(record: IdsjmkVehicleRecord, routeType: number | undefined): { transportMode: string; label: string } {
  if (routeType !== undefined) {
    const transportMode = pidModeFromRouteType(routeType);
    return { transportMode, label: transportMode };
  }
  const vehicleType = numberFromRecord(record, ["vtype", "VType", "vehicleTypeCode", "ltype", "LType"]);
  if (vehicleType === 1) {
    return { transportMode: "tram", label: "tram" };
  }
  if (vehicleType === 3) {
    return { transportMode: "trolleybus", label: "trolleybus" };
  }
  if (vehicleType === 5) {
    return { transportMode: "train", label: "train" };
  }
  if (vehicleType !== undefined) {
    return { transportMode: "bus", label: "bus" };
  }
  const rawType = (stringFromRecord(record, ["vehicleType", "VehicleType", "type", "Type", "mode", "Mode", "transportMode"]) ?? "").toLowerCase();
  if (rawType.includes("tram") || rawType.includes("šalina")) {
    return { transportMode: "tram", label: "tram" };
  }
  if (rawType.includes("train") || rawType.includes("vlak")) {
    return { transportMode: "train", label: "train" };
  }
  if (rawType.includes("trolley") || rawType.includes("trolej")) {
    return { transportMode: "trolleybus", label: "trolleybus" };
  }
  return { transportMode: "bus", label: "bus" };
}

function pidRouteLabel(routeId: string | undefined, vehicleId: string | undefined): string | undefined {
  const route = emptyToUndefined(routeId)?.replace(/^L(?=[A-Z0-9])/i, "");
  if (route) {
    return route;
  }
  const metroMatch = vehicleId?.match(/^metro-([A-Z])-/i);
  return metroMatch?.[1]?.toUpperCase();
}

function transitTripStatus(
  currentStatus: transit_realtime.VehiclePosition.VehicleStopStatus | null | undefined,
  observedAt: string | undefined,
  delaySeconds: number | undefined
): TransitVehicleDetail["trip"]["status"] {
  if (observedAt && Date.now() - Date.parse(observedAt) > 2 * 60_000) {
    return "stale";
  }
  if (delaySeconds !== undefined) {
    if (delaySeconds > 60) {
      return "delayed";
    }
    if (delaySeconds < -60) {
      return "early";
    }
    return "on_time";
  }
  switch (currentStatus) {
    case gtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.STOPPED_AT:
      return "stopped";
    case gtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO:
    case gtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.INCOMING_AT:
      return "in_transit";
    default:
      return "unknown";
  }
}

function externalTransitStatus(observedAt: string | undefined, delaySeconds: number | undefined): TransitVehicleDetail["trip"]["status"] {
  if (observedAt && Date.now() - Date.parse(observedAt) > 15 * 60_000) {
    return "stale";
  }
  if (delaySeconds !== undefined) {
    if (delaySeconds > 60) {
      return "delayed";
    }
    if (delaySeconds < -60) {
      return "early";
    }
    return "on_time";
  }
  return "in_transit";
}

function stopRelation(stopSequence: number, currentStopSequence: number | undefined): TransitStopRelation {
  if (currentStopSequence === undefined) {
    return "unknown";
  }
  if (stopSequence < currentStopSequence) {
    return "previous";
  }
  if (stopSequence === currentStopSequence) {
    return "current";
  }
  if (stopSequence === currentStopSequence + 1) {
    return "next";
  }
  return "future";
}

function relationFromVehicleStatus(value: transit_realtime.VehiclePosition.VehicleStopStatus | null | undefined): TransitStopRelation | undefined {
  switch (value) {
    case gtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.STOPPED_AT:
      return "current";
    case gtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO:
    case gtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.INCOMING_AT:
      return "next";
    default:
      return undefined;
  }
}

function pidVehicleStopStatus(value: transit_realtime.VehiclePosition.VehicleStopStatus | null | undefined): string | undefined {
  switch (value) {
    case gtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.INCOMING_AT:
      return "incoming_at";
    case gtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.STOPPED_AT:
      return "stopped_at";
    case gtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO:
      return "in_transit_to";
    default:
      return undefined;
  }
}

function pidOccupancyStatus(value: transit_realtime.VehiclePosition.OccupancyStatus | null | undefined): string | undefined {
  switch (value) {
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.EMPTY:
      return "empty";
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.MANY_SEATS_AVAILABLE:
      return "many_seats_available";
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.FEW_SEATS_AVAILABLE:
      return "few_seats_available";
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.STANDING_ROOM_ONLY:
      return "standing_room_only";
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.CRUSHED_STANDING_ROOM_ONLY:
      return "crushed_standing_room_only";
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.FULL:
      return "full";
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.NOT_ACCEPTING_PASSENGERS:
      return "not_accepting_passengers";
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.NOT_BOARDABLE:
      return "not_boardable";
    default:
      return undefined;
  }
}

function normalizeTransitSourceId(value: string | undefined): TransitSourceId | undefined {
  if (!value || value === "pid_gtfs_rt") {
    return "pid_gtfs_rt";
  }
  if (value === "idsjmk_vehicle_positions" || value === "spravazeleznic_trains") {
    return value;
  }
  return undefined;
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function longToNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "object" && value !== null && "toNumber" in value && typeof value.toNumber === "function") {
    const parsed = value.toNumber();
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function recordValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  const entries = Object.entries(record);
  for (const key of keys) {
    const lowerKey = key.toLowerCase();
    const match = entries.find(([entryKey, value]) => entryKey.toLowerCase() === lowerKey && value !== undefined && value !== null);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

function numberFromRecord(record: Record<string, unknown>, keys: string[]): number | undefined {
  return optionalNumber(recordValue(record, keys));
}

function stringFromRecord(record: Record<string, unknown>, keys: string[]): string | undefined {
  const value = recordValue(record, keys);
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value).trim() || undefined;
}

function parseTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(trimmed)) {
    return parseTimestamp(numeric);
  }
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

function stableToken(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .slice(0, 96);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
