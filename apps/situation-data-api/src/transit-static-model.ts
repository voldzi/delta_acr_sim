import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import type { PublicTransitStaticFeedConfig, SituationDataConfig } from "./config.js";
import { ManagedResponseCache } from "./response-cache.js";

type TransitStaticSourceKind = "gtfs_static" | "geojson_static";

export interface TransitStaticStop {
  systemId: string;
  systemLabel: string;
  feedUrl: string;
  sourceKind: TransitStaticSourceKind;
  stopId: string;
  stopCode?: string;
  stopName: string;
  lon: number;
  lat: number;
  zoneId?: string;
  locationType?: string;
  parentStation?: string;
  wheelchairBoarding?: string;
}

export interface PublicTransitStaticStopPayload {
  stops: TransitStaticStop[];
  warnings: string[];
  loadedAt: string;
  modelVersion: string;
}

interface TransitStaticRoute {
  systemId: string;
  systemLabel: string;
  feedUrl: string;
  routeId: string;
  shortName?: string;
  longName?: string;
  routeType?: number;
  transportMode: string;
  color?: string;
  textColor?: string;
  agencyId?: string;
}

interface TransitStaticTrip {
  systemId: string;
  systemLabel: string;
  feedUrl: string;
  tripId: string;
  routeId: string;
  serviceId?: string;
  headsign?: string;
  shortName?: string;
  directionId?: string;
  blockId?: string;
  shapeId?: string;
}

interface TransitStaticStopTime {
  systemId: string;
  tripId: string;
  routeId: string;
  stopId: string;
  stopSequence: number;
  arrivalTime?: string;
  departureTime?: string;
  pickupType?: string;
  dropOffType?: string;
  timepoint?: string;
  departureSeconds?: number;
  arrivalSeconds?: number;
}

interface TransitStaticCalendar {
  systemId: string;
  serviceId: string;
  startDate?: string;
  endDate?: string;
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
}

interface TransitStaticCalendarDate {
  systemId: string;
  serviceId: string;
  date: string;
  exceptionType: "added" | "removed" | "unknown";
}

type WeekdayKey = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

interface TransitStaticShapeText {
  systemId: string;
  text: string;
  headers: string[];
}

interface TransitStaticReadModel {
  contractVersion: "sim-transit-static-read-model-v1";
  loadedAt: string;
  modelVersion: string;
  feedSignature: string;
  stops: Map<string, TransitStaticStop>;
  routes: Map<string, TransitStaticRoute>;
  trips: Map<string, TransitStaticTrip>;
  stopTimesByTrip: Map<string, TransitStaticStopTime[]>;
  stopTimesByStop: Map<string, TransitStaticStopTime[]>;
  tripsByRoute: Map<string, TransitStaticTrip[]>;
  stopIdsByRoute: Map<string, Map<string, number>>;
  calendars: Map<string, TransitStaticCalendar>;
  calendarDates: Map<string, TransitStaticCalendarDate>;
  shapeTexts: Map<string, TransitStaticShapeText>;
  feedSummaries: TransitStaticFeedSummary[];
  warnings: string[];
}

interface TransitStaticFeedSummary {
  systemId: string;
  label: string;
  url: string;
  kind: TransitStaticSourceKind;
  stops: number;
  routes: number;
  trips: number;
  stopTimes: number;
  shapesAvailable: boolean;
  warning?: string;
}

interface TransitStaticDetailOptions {
  includeShape?: boolean;
  maxDepartures?: number;
  maxRoutes?: number;
  maxTrips?: number;
  maxStopTimes?: number;
  maxShapePoints?: number;
  date?: string;
  time?: string;
}

export interface TransitStaticStopDetail {
  contractVersion: "sim-transit-stop-detail-v1";
  generatedAt: string;
  sourceId: "public_transit_static";
  systemId: string;
  modelVersion: string;
  stop: TransitStaticStop;
  routes: TransitStaticRouteSummary[];
  departures: TransitStaticDeparture[];
  quality: TransitStaticQuality;
}

export interface TransitStaticStopDepartures {
  contractVersion: "sim-transit-stop-departures-v1";
  generatedAt: string;
  sourceId: "public_transit_static";
  systemId: string;
  modelVersion: string;
  stop: TransitStaticStopSummary;
  departures: TransitStaticDeparture[];
  quality: TransitStaticQuality;
}

export interface TransitStaticRouteDetail {
  contractVersion: "sim-transit-route-detail-v1";
  generatedAt: string;
  sourceId: "public_transit_static";
  systemId: string;
  modelVersion: string;
  route: TransitStaticRouteSummary;
  trips: TransitStaticTripSummary[];
  stops: TransitStaticStopSummary[];
  routeShape?: TransitStaticRouteShape;
  quality: TransitStaticQuality;
}

export interface TransitStaticTripDetail {
  contractVersion: "sim-transit-trip-detail-v1";
  generatedAt: string;
  sourceId: "public_transit_static";
  systemId: string;
  modelVersion: string;
  route?: TransitStaticRouteSummary;
  trip: TransitStaticTripSummary;
  stopTimes: TransitStaticStopTimeDetail[];
  routeShape?: TransitStaticRouteShape;
  quality: TransitStaticQuality;
}

interface TransitStaticRouteSummary {
  systemId: string;
  routeId: string;
  routeShortName?: string;
  routeLongName?: string;
  transportMode: string;
  routeType?: number;
  color?: string;
  textColor?: string;
  agencyId?: string;
}

interface TransitStaticTripSummary {
  systemId: string;
  tripId: string;
  routeId: string;
  routeShortName?: string;
  routeLongName?: string;
  transportMode?: string;
  destination?: string;
  directionId?: string;
  serviceId?: string;
  shapeId?: string;
}

interface TransitStaticStopSummary {
  systemId: string;
  stopId: string;
  stopCode?: string;
  stopName: string;
  position?: {
    lat: number;
    lon: number;
  };
  zoneId?: string;
  wheelchairBoarding?: string;
}

interface TransitStaticDeparture {
  systemId: string;
  stopId: string;
  tripId: string;
  routeId: string;
  routeShortName?: string;
  routeLongName?: string;
  transportMode: string;
  destination?: string;
  directionId?: string;
  serviceId?: string;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  minutesFromQueryTime?: number;
  stopSequence: number;
  serviceActive: boolean;
}

interface TransitStaticStopTimeDetail {
  stopId: string;
  stopName?: string;
  stopSequence: number;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  position?: {
    lat: number;
    lon: number;
  };
}

interface TransitStaticRouteShape {
  shapeId: string;
  coordinates: Array<[number, number]>;
  truncated: boolean;
}

interface TransitStaticQuality {
  staticModelAvailable: boolean;
  scheduleAvailable: boolean;
  routeShapeAvailable: boolean;
  generatedFrom: string[];
  modelLoadedAt: string;
  feedCount: number;
  warnings: string[];
}

const readModelCaches = new Map<string, ManagedResponseCache<TransitStaticReadModel>>();

export class TransitStaticModelService {
  constructor(private readonly config: SituationDataConfig) {}

  async getStopDetail(systemId: string, stopId: string, options: TransitStaticDetailOptions = {}): Promise<TransitStaticStopDetail | undefined> {
    const model = await getPublicTransitStaticReadModel(this.config);
    const stop = model.stops.get(modelKey(systemId, stopId));
    if (!stop) {
      return undefined;
    }
    const generatedAt = new Date().toISOString();
    const departures = departuresForStop(model, stop, options);
    return {
      contractVersion: "sim-transit-stop-detail-v1",
      generatedAt,
      sourceId: "public_transit_static",
      systemId: stop.systemId,
      modelVersion: model.modelVersion,
      stop,
      routes: routesForStop(model, stop, options),
      departures,
      quality: qualityFor(model, departures.length > 0, false)
    };
  }

  async getStopDepartures(systemId: string, stopId: string, options: TransitStaticDetailOptions = {}): Promise<TransitStaticStopDepartures | undefined> {
    const model = await getPublicTransitStaticReadModel(this.config);
    const stop = model.stops.get(modelKey(systemId, stopId));
    if (!stop) {
      return undefined;
    }
    const departures = departuresForStop(model, stop, options);
    return {
      contractVersion: "sim-transit-stop-departures-v1",
      generatedAt: new Date().toISOString(),
      sourceId: "public_transit_static",
      systemId: stop.systemId,
      modelVersion: model.modelVersion,
      stop: stopSummary(stop),
      departures,
      quality: qualityFor(model, departures.length > 0, false)
    };
  }

  async getRouteDetail(systemId: string, routeId: string, options: TransitStaticDetailOptions = {}): Promise<TransitStaticRouteDetail | undefined> {
    const model = await getPublicTransitStaticReadModel(this.config);
    const route = model.routes.get(modelKey(systemId, routeId));
    if (!route) {
      return undefined;
    }
    const routeKey = modelKey(route.systemId, route.routeId);
    const trips = (model.tripsByRoute.get(routeKey) ?? []).slice(0, clampInteger(options.maxTrips, 1, 300, 60));
    const stopOrder = model.stopIdsByRoute.get(routeKey);
    const stops = stopOrder
      ? Array.from(stopOrder.entries())
          .sort((left, right) => left[1] - right[1])
          .slice(0, clampInteger(options.maxStopTimes, 1, 500, 120))
          .map(([stopId]) => model.stops.get(modelKey(systemId, stopId)))
          .filter((stop): stop is TransitStaticStop => Boolean(stop))
          .map(stopSummary)
      : [];
    const shape = options.includeShape ?? true ? shapeForFirstTrip(model, trips, options) : undefined;
    return {
      contractVersion: "sim-transit-route-detail-v1",
      generatedAt: new Date().toISOString(),
      sourceId: "public_transit_static",
      systemId: route.systemId,
      modelVersion: model.modelVersion,
      route: routeSummary(route),
      trips: trips.map((trip) => tripSummary(model, trip)),
      stops,
      routeShape: shape,
      quality: qualityFor(model, stops.length > 0, Boolean(shape))
    };
  }

  async getTripDetail(systemId: string, tripId: string, options: TransitStaticDetailOptions = {}): Promise<TransitStaticTripDetail | undefined> {
    const model = await getPublicTransitStaticReadModel(this.config);
    const trip = model.trips.get(modelKey(systemId, tripId));
    if (!trip) {
      return undefined;
    }
    const route = model.routes.get(modelKey(trip.systemId, trip.routeId));
    const limit = clampInteger(options.maxStopTimes, 1, 500, 120);
    const stopTimes = (model.stopTimesByTrip.get(modelKey(systemId, tripId)) ?? []).slice(0, limit);
    const shape = options.includeShape ?? true ? shapeForTrip(model, trip, options) : undefined;
    return {
      contractVersion: "sim-transit-trip-detail-v1",
      generatedAt: new Date().toISOString(),
      sourceId: "public_transit_static",
      systemId: trip.systemId,
      modelVersion: model.modelVersion,
      route: route ? routeSummary(route) : undefined,
      trip: tripSummary(model, trip),
      stopTimes: stopTimes.map((stopTime) => stopTimeDetail(model, stopTime)),
      routeShape: shape,
      quality: qualityFor(model, stopTimes.length > 0, Boolean(shape))
    };
  }
}

export async function getPublicTransitStaticStops(config: SituationDataConfig): Promise<TransitStaticStop[]> {
  const payload = await getPublicTransitStaticStopPayload(config);
  return payload.stops.slice(0, Math.max(1, config.publicTransitStaticMaxStops));
}

export async function getPublicTransitStaticStopPayload(config: SituationDataConfig): Promise<PublicTransitStaticStopPayload> {
  const model = await getPublicTransitStaticReadModel(config);
  return {
    stops: Array.from(model.stops.values()),
    warnings: model.warnings,
    loadedAt: model.loadedAt,
    modelVersion: model.modelVersion
  };
}

export async function getPublicTransitStaticReadModel(config: SituationDataConfig): Promise<TransitStaticReadModel> {
  return readModelCacheFor(config).getOrLoad(publicTransitStaticReadModelCacheKey(config), () => fetchPublicTransitStaticReadModel(config));
}

function readModelCacheFor(config: SituationDataConfig): ManagedResponseCache<TransitStaticReadModel> {
  const ttlSeconds = Math.max(3600, config.publicTransitStaticCacheTtlSeconds);
  const staleSeconds = Math.max(ttlSeconds, config.staleIfErrorSeconds);
  const cacheKey = `${ttlSeconds}:${staleSeconds}`;
  const existing = readModelCaches.get(cacheKey);
  if (existing) {
    return existing;
  }
  const created = new ManagedResponseCache<TransitStaticReadModel>({
    ttlMs: ttlSeconds * 1000,
    staleIfErrorMs: staleSeconds * 1000,
    maxEntries: 4
  });
  readModelCaches.set(cacheKey, created);
  return created;
}

function publicTransitStaticReadModelCacheKey(config: SituationDataConfig): string {
  return `public_transit_static_read_model:${stableToken(`${feedSignature(config)}|maxStops=${config.publicTransitStaticMaxStops}`)}`;
}

async function fetchPublicTransitStaticReadModel(config: SituationDataConfig): Promise<TransitStaticReadModel> {
  const signature = feedSignature(config);
  const model = emptyModel(signature);
  const staticFeedTimeoutMs = Math.max(config.requestTimeoutMs, 60_000);
  const settled = await Promise.allSettled([
    ...config.publicTransitStaticGtfsFeeds.map((feed) => fetchGtfsStaticFeed(feed, staticFeedTimeoutMs)),
    ...config.publicTransitStaticGeojsonFeeds.map((feed) => fetchGeojsonStaticFeed(feed, staticFeedTimeoutMs))
  ]);

  for (const result of settled) {
    if (result.status === "fulfilled") {
      mergeFeedModel(model, result.value);
    } else {
      model.warnings.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }

  if (model.stops.size === 0) {
    throw new Error(`public_transit_static did not load any stops${model.warnings.length ? `: ${model.warnings.join("; ")}` : "."}`);
  }

  sortModelIndexes(model);
  return model;
}

function emptyModel(feedSignatureValue: string): TransitStaticReadModel {
  return {
    contractVersion: "sim-transit-static-read-model-v1",
    loadedAt: new Date().toISOString(),
    modelVersion: `static-${shortHash(feedSignatureValue)}`,
    feedSignature: feedSignatureValue,
    stops: new Map(),
    routes: new Map(),
    trips: new Map(),
    stopTimesByTrip: new Map(),
    stopTimesByStop: new Map(),
    tripsByRoute: new Map(),
    stopIdsByRoute: new Map(),
    calendars: new Map(),
    calendarDates: new Map(),
    shapeTexts: new Map(),
    feedSummaries: [],
    warnings: []
  };
}

interface TransitStaticFeedModel {
  stops: TransitStaticStop[];
  routes: TransitStaticRoute[];
  trips: TransitStaticTrip[];
  stopTimes: TransitStaticStopTime[];
  calendars: TransitStaticCalendar[];
  calendarDates: TransitStaticCalendarDate[];
  shapeText?: TransitStaticShapeText;
  summary: TransitStaticFeedSummary;
}

async function fetchGtfsStaticFeed(feed: PublicTransitStaticFeedConfig, timeoutMs: number): Promise<TransitStaticFeedModel> {
  const archive = await requestBytes(feed.url, timeoutMs, {
    accept: "application/zip,application/octet-stream,*/*",
    "user-agent": "csm-sim-situation-data/0.1"
  });
  const files = unzipSync(archive);
  const stopsText = readGtfsText(files, "stops.txt", feed.url);
  const routesText = readOptionalGtfsText(files, "routes.txt");
  const tripsText = readOptionalGtfsText(files, "trips.txt");
  const stopTimesText = readOptionalGtfsText(files, "stop_times.txt");
  const shapesText = readOptionalGtfsText(files, "shapes.txt");
  const calendarText = readOptionalGtfsText(files, "calendar.txt");
  const calendarDatesText = readOptionalGtfsText(files, "calendar_dates.txt");

  const stops = parseGtfsStops(feed, stopsText);
  const routes = routesText ? parseGtfsRoutes(feed, routesText) : [];
  const trips = tripsText ? parseGtfsTrips(feed, tripsText) : [];
  const tripRouteById = new Map(trips.map((trip) => [trip.tripId, trip.routeId]));
  const stopTimes = stopTimesText ? parseGtfsStopTimes(feed, stopTimesText, tripRouteById) : [];
  const calendars = calendarText ? parseGtfsCalendars(feed, calendarText) : [];
  const calendarDates = calendarDatesText ? parseGtfsCalendarDates(feed, calendarDatesText) : [];
  return {
    stops,
    routes,
    trips,
    stopTimes,
    calendars,
    calendarDates,
    shapeText: shapesText ? { systemId: feed.systemId, text: shapesText, headers: parseCsvHeader(shapesText) } : undefined,
    summary: {
      systemId: feed.systemId,
      label: feed.label,
      url: feed.url,
      kind: "gtfs_static",
      stops: stops.length,
      routes: routes.length,
      trips: trips.length,
      stopTimes: stopTimes.length,
      shapesAvailable: Boolean(shapesText)
    }
  };
}

async function fetchGeojsonStaticFeed(feed: PublicTransitStaticFeedConfig, timeoutMs: number): Promise<TransitStaticFeedModel> {
  const archive = await requestBytes(feed.url, timeoutMs, {
    accept: "application/zip,application/geo+json,application/json,application/octet-stream,*/*",
    "user-agent": "csm-sim-situation-data/0.1"
  });
  const files = unzipSync(archive);
  const geojsonName = Object.keys(files).find((name) => {
    const basename = archiveBasename(name);
    return basename.endsWith(".geojson") || basename.endsWith(".json");
  });
  if (!geojsonName) {
    throw new Error(`public_transit_static GeoJSON archive did not contain a GeoJSON file: ${feed.url}`);
  }
  const geojsonFile = files[geojsonName];
  if (!geojsonFile) {
    throw new Error(`public_transit_static GeoJSON file was empty: ${feed.url}`);
  }
  const stops = parseGeojsonStops(feed, JSON.parse(decodeText(geojsonFile)));
  return {
    stops,
    routes: [],
    trips: [],
    stopTimes: [],
    calendars: [],
    calendarDates: [],
    summary: {
      systemId: feed.systemId,
      label: feed.label,
      url: feed.url,
      kind: "geojson_static",
      stops: stops.length,
      routes: 0,
      trips: 0,
      stopTimes: 0,
      shapesAvailable: false
    }
  };
}

function mergeFeedModel(model: TransitStaticReadModel, feedModel: TransitStaticFeedModel): void {
  model.feedSummaries.push(feedModel.summary);
  for (const stop of feedModel.stops) {
    model.stops.set(modelKey(stop.systemId, stop.stopId), stop);
  }
  for (const route of feedModel.routes) {
    model.routes.set(modelKey(route.systemId, route.routeId), route);
  }
  for (const trip of feedModel.trips) {
    const tripKey = modelKey(trip.systemId, trip.tripId);
    model.trips.set(tripKey, trip);
    appendMapArray(model.tripsByRoute, modelKey(trip.systemId, trip.routeId), trip);
  }
  for (const stopTime of feedModel.stopTimes) {
    appendMapArray(model.stopTimesByTrip, modelKey(stopTime.systemId, stopTime.tripId), stopTime);
    appendMapArray(model.stopTimesByStop, modelKey(stopTime.systemId, stopTime.stopId), stopTime);
    const routeStopOrder = getOrCreateMap(model.stopIdsByRoute, modelKey(stopTime.systemId, stopTime.routeId));
    const existing = routeStopOrder.get(stopTime.stopId);
    if (existing === undefined || stopTime.stopSequence < existing) {
      routeStopOrder.set(stopTime.stopId, stopTime.stopSequence);
    }
  }
  for (const calendar of feedModel.calendars) {
    model.calendars.set(modelKey(calendar.systemId, calendar.serviceId), calendar);
  }
  for (const calendarDate of feedModel.calendarDates) {
    model.calendarDates.set(calendarDateKey(calendarDate.systemId, calendarDate.serviceId, calendarDate.date), calendarDate);
  }
  if (feedModel.shapeText) {
    model.shapeTexts.set(feedModel.shapeText.systemId, feedModel.shapeText);
  }
}

function sortModelIndexes(model: TransitStaticReadModel): void {
  for (const stopTimes of model.stopTimesByTrip.values()) {
    stopTimes.sort((left, right) => left.stopSequence - right.stopSequence);
  }
  for (const stopTimes of model.stopTimesByStop.values()) {
    stopTimes.sort((left, right) => {
      const leftSeconds = left.departureSeconds ?? left.arrivalSeconds ?? Number.MAX_SAFE_INTEGER;
      const rightSeconds = right.departureSeconds ?? right.arrivalSeconds ?? Number.MAX_SAFE_INTEGER;
      return leftSeconds - rightSeconds || left.stopSequence - right.stopSequence;
    });
  }
  for (const trips of model.tripsByRoute.values()) {
    trips.sort((left, right) => left.tripId.localeCompare(right.tripId, "cs"));
  }
}

function parseGtfsStops(feed: PublicTransitStaticFeedConfig, text: string): TransitStaticStop[] {
  const stops: TransitStaticStop[] = [];
  forEachCsvRecord(text, (record) => {
    const stop = mapGtfsStopRecord(feed, record);
    if (stop) {
      stops.push(stop);
    }
  });
  return stops;
}

function parseGtfsRoutes(feed: PublicTransitStaticFeedConfig, text: string): TransitStaticRoute[] {
  const routes: TransitStaticRoute[] = [];
  forEachCsvRecord(text, (record) => {
    const routeId = optionalString(record.route_id);
    if (!routeId) {
      return;
    }
    const routeType = optionalNumber(record.route_type);
    routes.push({
      systemId: feed.systemId,
      systemLabel: feed.label,
      feedUrl: feed.url,
      routeId,
      shortName: optionalString(record.route_short_name),
      longName: optionalString(record.route_long_name),
      routeType,
      transportMode: transportModeFromGtfsRouteType(routeType),
      color: optionalString(record.route_color),
      textColor: optionalString(record.route_text_color),
      agencyId: optionalString(record.agency_id)
    });
  });
  return routes;
}

function parseGtfsTrips(feed: PublicTransitStaticFeedConfig, text: string): TransitStaticTrip[] {
  const trips: TransitStaticTrip[] = [];
  forEachCsvRecord(text, (record) => {
    const tripId = optionalString(record.trip_id);
    const routeId = optionalString(record.route_id);
    if (!tripId || !routeId) {
      return;
    }
    trips.push({
      systemId: feed.systemId,
      systemLabel: feed.label,
      feedUrl: feed.url,
      tripId,
      routeId,
      serviceId: optionalString(record.service_id),
      headsign: optionalString(record.trip_headsign),
      shortName: optionalString(record.trip_short_name),
      directionId: optionalString(record.direction_id),
      blockId: optionalString(record.block_id),
      shapeId: optionalString(record.shape_id)
    });
  });
  return trips;
}

function parseGtfsStopTimes(feed: PublicTransitStaticFeedConfig, text: string, tripRouteById: Map<string, string>): TransitStaticStopTime[] {
  const stopTimes: TransitStaticStopTime[] = [];
  forEachCsvRecord(text, (record) => {
    const tripId = optionalString(record.trip_id);
    const stopId = optionalString(record.stop_id);
    const stopSequence = optionalNumber(record.stop_sequence);
    if (!tripId || !stopId || stopSequence === undefined) {
      return;
    }
    const routeId = tripRouteById.get(tripId);
    if (!routeId) {
      return;
    }
    const departureTime = optionalString(record.departure_time);
    const arrivalTime = optionalString(record.arrival_time);
    stopTimes.push({
      systemId: feed.systemId,
      tripId,
      routeId,
      stopId,
      stopSequence,
      arrivalTime,
      departureTime,
      pickupType: optionalString(record.pickup_type),
      dropOffType: optionalString(record.drop_off_type),
      timepoint: optionalString(record.timepoint),
      departureSeconds: parseGtfsTimeToSeconds(departureTime),
      arrivalSeconds: parseGtfsTimeToSeconds(arrivalTime)
    });
  });
  return stopTimes;
}

function parseGtfsCalendars(feed: PublicTransitStaticFeedConfig, text: string): TransitStaticCalendar[] {
  const calendars: TransitStaticCalendar[] = [];
  forEachCsvRecord(text, (record) => {
    const serviceId = optionalString(record.service_id);
    if (!serviceId) {
      return;
    }
    calendars.push({
      systemId: feed.systemId,
      serviceId,
      startDate: normalizeGtfsDate(record.start_date),
      endDate: normalizeGtfsDate(record.end_date),
      monday: record.monday === "1",
      tuesday: record.tuesday === "1",
      wednesday: record.wednesday === "1",
      thursday: record.thursday === "1",
      friday: record.friday === "1",
      saturday: record.saturday === "1",
      sunday: record.sunday === "1"
    });
  });
  return calendars;
}

function parseGtfsCalendarDates(feed: PublicTransitStaticFeedConfig, text: string): TransitStaticCalendarDate[] {
  const dates: TransitStaticCalendarDate[] = [];
  forEachCsvRecord(text, (record) => {
    const serviceId = optionalString(record.service_id);
    const date = normalizeGtfsDate(record.date);
    if (!serviceId || !date) {
      return;
    }
    dates.push({
      systemId: feed.systemId,
      serviceId,
      date,
      exceptionType: record.exception_type === "1" ? "added" : record.exception_type === "2" ? "removed" : "unknown"
    });
  });
  return dates;
}

function parseGeojsonStops(feed: PublicTransitStaticFeedConfig, collection: unknown): TransitStaticStop[] {
  if (!isRecord(collection) || collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    return [];
  }
  return collection.features
    .map((feature, index) => mapGeojsonStopFeature(feed, feature, index))
    .filter((stop): stop is TransitStaticStop => Boolean(stop));
}

function mapGtfsStopRecord(feed: PublicTransitStaticFeedConfig, record: Record<string, string>): TransitStaticStop | undefined {
  const stopId = optionalString(record.stop_id);
  const stopName = optionalString(record.stop_name);
  const lat = optionalNumber(record.stop_lat);
  const lon = optionalNumber(record.stop_lon);
  if (!stopId || !stopName || lat === undefined || lon === undefined) {
    return undefined;
  }
  if (!isCzechContextCoordinate(lat, lon)) {
    return undefined;
  }
  return {
    systemId: feed.systemId,
    systemLabel: feed.label,
    feedUrl: feed.url,
    sourceKind: "gtfs_static",
    stopId,
    stopCode: optionalString(record.stop_code),
    stopName,
    lon,
    lat,
    zoneId: optionalString(record.zone_id),
    locationType: optionalString(record.location_type),
    parentStation: optionalString(record.parent_station),
    wheelchairBoarding: optionalString(record.wheelchair_boarding)
  };
}

function mapGeojsonStopFeature(feed: PublicTransitStaticFeedConfig, feature: unknown, index: number): TransitStaticStop | undefined {
  if (!isRecord(feature) || !isRecord(feature.geometry) || feature.geometry.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) {
    return undefined;
  }
  const [lonRaw, latRaw] = feature.geometry.coordinates;
  const lon = Number(lonRaw);
  const lat = Number(latRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !isCzechContextCoordinate(lat, lon)) {
    return undefined;
  }
  const properties = isRecord(feature.properties) ? feature.properties : {};
  const stopName = optionalString(properties.stop_name) ?? optionalString(properties.name) ?? optionalString(properties.zast_jm);
  if (!stopName) {
    return undefined;
  }
  const stopCode = optionalString(properties.stop_code) ?? optionalString(properties.ref) ?? optionalString(properties.sloupek_jm);
  return {
    systemId: feed.systemId,
    systemLabel: feed.label,
    feedUrl: feed.url,
    sourceKind: "geojson_static",
    stopId: optionalString(properties.stop_id) ?? optionalString(properties.id) ?? `${stopName}:${stopCode ?? ""}:${lon}:${lat}:${index}`,
    stopCode,
    stopName,
    lon,
    lat,
    wheelchairBoarding: normalizeWheelchairBoarding(optionalString(properties.wheelchair_boarding) ?? optionalString(properties.bezbarier))
  };
}

function departuresForStop(model: TransitStaticReadModel, stop: TransitStaticStop, options: TransitStaticDetailOptions): TransitStaticDeparture[] {
  const queryTime = normalizeQueryTime(options);
  const limit = clampInteger(options.maxDepartures, 1, 120, 30);
  const stopTimes = model.stopTimesByStop.get(modelKey(stop.systemId, stop.stopId)) ?? [];
  const departures: TransitStaticDeparture[] = [];
  for (const stopTime of stopTimes) {
    const seconds = stopTime.departureSeconds ?? stopTime.arrivalSeconds;
    if (seconds === undefined || seconds < queryTime.seconds - 60) {
      continue;
    }
    const trip = model.trips.get(modelKey(stopTime.systemId, stopTime.tripId));
    if (!trip || !isTripServiceActive(model, trip, queryTime.date)) {
      continue;
    }
    const route = model.routes.get(modelKey(stopTime.systemId, stopTime.routeId));
    departures.push({
      systemId: stopTime.systemId,
      stopId: stopTime.stopId,
      tripId: stopTime.tripId,
      routeId: stopTime.routeId,
      routeShortName: route?.shortName,
      routeLongName: route?.longName,
      transportMode: route?.transportMode ?? "public_transport",
      destination: trip.headsign,
      directionId: trip.directionId,
      serviceId: trip.serviceId,
      scheduledArrival: stopTime.arrivalTime,
      scheduledDeparture: stopTime.departureTime,
      minutesFromQueryTime: Math.round((seconds - queryTime.seconds) / 60),
      stopSequence: stopTime.stopSequence,
      serviceActive: true
    });
    if (departures.length >= limit) {
      break;
    }
  }
  return departures;
}

function routesForStop(model: TransitStaticReadModel, stop: TransitStaticStop, options: TransitStaticDetailOptions): TransitStaticRouteSummary[] {
  const limit = clampInteger(options.maxRoutes, 1, 120, 30);
  const stopTimes = model.stopTimesByStop.get(modelKey(stop.systemId, stop.stopId)) ?? [];
  const seen = new Set<string>();
  const routes: TransitStaticRouteSummary[] = [];
  for (const stopTime of stopTimes) {
    const key = modelKey(stopTime.systemId, stopTime.routeId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const route = model.routes.get(key);
    if (!route) {
      continue;
    }
    routes.push(routeSummary(route));
    if (routes.length >= limit) {
      break;
    }
  }
  return routes;
}

function shapeForFirstTrip(
  model: TransitStaticReadModel,
  trips: TransitStaticTrip[],
  options: TransitStaticDetailOptions
): TransitStaticRouteShape | undefined {
  for (const trip of trips) {
    const shape = shapeForTrip(model, trip, options);
    if (shape) {
      return shape;
    }
  }
  return undefined;
}

function shapeForTrip(model: TransitStaticReadModel, trip: TransitStaticTrip, options: TransitStaticDetailOptions): TransitStaticRouteShape | undefined {
  if (!trip.shapeId) {
    return undefined;
  }
  const shapeText = model.shapeTexts.get(trip.systemId);
  if (!shapeText) {
    return undefined;
  }
  const indexes = headerIndexes(shapeText.headers);
  if (indexes.shape_id === undefined || indexes.shape_pt_lat === undefined || indexes.shape_pt_lon === undefined) {
    return undefined;
  }
  const limit = clampInteger(options.maxShapePoints, 10, 3000, 700);
  const points: Array<{ lon: number; lat: number; sequence: number }> = [];
  let matchedCount = 0;
  forEachCsvRecord(shapeText.text, (record) => {
    if (record.shape_id !== trip.shapeId) {
      return;
    }
    matchedCount += 1;
    if (points.length >= limit) {
      return;
    }
    const lat = optionalNumber(record.shape_pt_lat);
    const lon = optionalNumber(record.shape_pt_lon);
    if (lat === undefined || lon === undefined) {
      return;
    }
    points.push({
      lat,
      lon,
      sequence: optionalNumber(record.shape_pt_sequence) ?? matchedCount
    });
  });
  if (points.length === 0) {
    return undefined;
  }
  points.sort((left, right) => left.sequence - right.sequence);
  return {
    shapeId: trip.shapeId,
    coordinates: points.map((point) => [point.lon, point.lat]),
    truncated: matchedCount > points.length
  };
}

function routeSummary(route: TransitStaticRoute): TransitStaticRouteSummary {
  return {
    systemId: route.systemId,
    routeId: route.routeId,
    routeShortName: route.shortName,
    routeLongName: route.longName,
    transportMode: route.transportMode,
    routeType: route.routeType,
    color: route.color,
    textColor: route.textColor,
    agencyId: route.agencyId
  };
}

function tripSummary(model: TransitStaticReadModel, trip: TransitStaticTrip): TransitStaticTripSummary {
  const route = model.routes.get(modelKey(trip.systemId, trip.routeId));
  return {
    systemId: trip.systemId,
    tripId: trip.tripId,
    routeId: trip.routeId,
    routeShortName: route?.shortName,
    routeLongName: route?.longName,
    transportMode: route?.transportMode,
    destination: trip.headsign,
    directionId: trip.directionId,
    serviceId: trip.serviceId,
    shapeId: trip.shapeId
  };
}

function stopSummary(stop: TransitStaticStop): TransitStaticStopSummary {
  return {
    systemId: stop.systemId,
    stopId: stop.stopId,
    stopCode: stop.stopCode,
    stopName: stop.stopName,
    position: {
      lat: stop.lat,
      lon: stop.lon
    },
    zoneId: stop.zoneId,
    wheelchairBoarding: stop.wheelchairBoarding
  };
}

function stopTimeDetail(model: TransitStaticReadModel, stopTime: TransitStaticStopTime): TransitStaticStopTimeDetail {
  const stop = model.stops.get(modelKey(stopTime.systemId, stopTime.stopId));
  return {
    stopId: stopTime.stopId,
    stopName: stop?.stopName,
    stopSequence: stopTime.stopSequence,
    scheduledArrival: stopTime.arrivalTime,
    scheduledDeparture: stopTime.departureTime,
    position: stop
      ? {
          lat: stop.lat,
          lon: stop.lon
        }
      : undefined
  };
}

function qualityFor(model: TransitStaticReadModel, scheduleAvailable: boolean, routeShapeAvailable: boolean): TransitStaticQuality {
  return {
    staticModelAvailable: true,
    scheduleAvailable,
    routeShapeAvailable,
    generatedFrom: model.feedSummaries.map((summary) => `${summary.systemId}:${summary.kind}`),
    modelLoadedAt: model.loadedAt,
    feedCount: model.feedSummaries.length,
    warnings: model.warnings
  };
}

function isTripServiceActive(model: TransitStaticReadModel, trip: TransitStaticTrip, normalizedDate: string): boolean {
  if (!trip.serviceId) {
    return true;
  }
  const calendarDate = model.calendarDates.get(calendarDateKey(trip.systemId, trip.serviceId, normalizedDate));
  if (calendarDate?.exceptionType === "added") {
    return true;
  }
  if (calendarDate?.exceptionType === "removed") {
    return false;
  }
  const calendar = model.calendars.get(modelKey(trip.systemId, trip.serviceId));
  if (!calendar) {
    return true;
  }
  if (calendar.startDate && normalizedDate < calendar.startDate) {
    return false;
  }
  if (calendar.endDate && normalizedDate > calendar.endDate) {
    return false;
  }
  const weekday = weekdayKey(normalizedDate);
  return weekday ? calendar[weekday] : true;
}

function normalizeQueryTime(options: TransitStaticDetailOptions): { date: string; seconds: number } {
  const local = currentPragueDateTime();
  return {
    date: normalizeGtfsDate(options.date) ?? local.date,
    seconds: parseGtfsTimeToSeconds(options.time) ?? local.seconds
  };
}

function currentPragueDateTime(): { date: string; seconds: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const date = `${value("year")}${value("month")}${value("day")}`;
  const seconds = Number(value("hour")) * 3600 + Number(value("minute")) * 60 + Number(value("second"));
  return { date, seconds };
}

function weekdayKey(date: string): WeekdayKey | undefined {
  const parsed = parseGtfsDateToDate(date);
  if (!parsed) {
    return undefined;
  }
  switch (parsed.getUTCDay()) {
    case 0:
      return "sunday";
    case 1:
      return "monday";
    case 2:
      return "tuesday";
    case 3:
      return "wednesday";
    case 4:
      return "thursday";
    case 5:
      return "friday";
    case 6:
      return "saturday";
    default:
      return undefined;
  }
}

function parseGtfsDateToDate(date: string): Date | undefined {
  const normalized = normalizeGtfsDate(date);
  if (!normalized) {
    return undefined;
  }
  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(4, 6));
  const day = Number(normalized.slice(6, 8));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return undefined;
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function parseGtfsTimeToSeconds(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.trim().match(/^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? "0");
  return Number.isFinite(hours) && Number.isFinite(minutes) && Number.isFinite(seconds) ? hours * 3600 + minutes * 60 + seconds : undefined;
}

function normalizeGtfsDate(value: string | undefined): string | undefined {
  const normalized = optionalString(value)?.replace(/-/g, "");
  return normalized && /^\d{8}$/.test(normalized) ? normalized : undefined;
}

function transportModeFromGtfsRouteType(routeType: number | undefined): string {
  switch (routeType) {
    case 0:
      return "tram";
    case 1:
      return "metro";
    case 2:
      return "train";
    case 4:
      return "ferry";
    case 5:
      return "cable_tram";
    case 6:
      return "aerial_lift";
    case 7:
      return "funicular";
    case 11:
      return "trolleybus";
    case 12:
      return "monorail";
    case 3:
      return "bus";
    default:
      return "public_transport";
  }
}

function forEachCsvRecord(text: string, callback: (record: Record<string, string>) => void): void {
  let header: string[] | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    if (!header) {
      header = parseCsvLine(line);
      continue;
    }
    callback(rowToRecord(header, parseCsvLine(line)));
  }
}

function parseCsvHeader(text: string): string[] {
  return parseCsvLine(text.split(/\r?\n/, 1)[0] ?? "");
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        field += "\"";
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

function readGtfsText(files: Record<string, Uint8Array>, name: string, url: string): string {
  const text = readOptionalGtfsText(files, name);
  if (!text) {
    throw new Error(`public_transit_static GTFS archive did not contain ${name}: ${url}`);
  }
  return text;
}

function readOptionalGtfsText(files: Record<string, Uint8Array>, name: string): string | undefined {
  const entry = Object.entries(files).find(([path]) => archiveBasename(path) === name);
  return entry ? decodeText(entry[1]) : undefined;
}

function archiveBasename(path: string): string {
  return path.split(/[\\/]/).pop()?.toLowerCase() ?? path.toLowerCase();
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

function appendMapArray<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

function getOrCreateMap<K, A, B>(map: Map<K, Map<A, B>>, key: K): Map<A, B> {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }
  const created = new Map<A, B>();
  map.set(key, created);
  return created;
}

function modelKey(systemId: string, id: string): string {
  return `${systemId}\u001f${id}`;
}

function calendarDateKey(systemId: string, serviceId: string, date: string): string {
  return `${systemId}\u001f${serviceId}\u001f${date}`;
}

function feedSignature(config: SituationDataConfig): string {
  return config.publicTransitStaticGtfsFeeds
    .concat(config.publicTransitStaticGeojsonFeeds)
    .map((feed) => `${feed.systemId}|${feed.label}|${feed.url}`)
    .sort()
    .join(",");
}

function stableToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
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

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeWheelchairBoarding(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["ano", "yes", "true", "1"].includes(normalized)) {
    return "1";
  }
  if (["ne", "no", "false", "0"].includes(normalized)) {
    return "2";
  }
  return value;
}

function isCzechContextCoordinate(lat: number, lon: number): boolean {
  return lat >= 47.5 && lat <= 52.5 && lon >= 10 && lon <= 20.5;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeText(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}
