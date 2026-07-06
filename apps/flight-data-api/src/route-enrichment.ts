import type { FlightDataConfig } from "./config.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { AggregatedFlightTrack, FlightItinerary, FlightItineraryAirport } from "./types.js";

const EARTH_RADIUS_KM = 6371.0088;
const MIN_ESTIMATION_SPEED_MPS = 30;
const SCHEDULE_UNAVAILABLE_REASON = "not_in_open_adsb_route_reference";

interface VrsRouteReference {
  callsign: string;
  airlineCode?: string;
  flightNumber?: string;
  airportCodes: string[];
}

interface LoadedFlightRoutes {
  loadedAt: string;
  routes: Map<string, VrsRouteReference>;
  airportsByIcao: Map<string, FlightItineraryAirport>;
  airportsByIata: Map<string, FlightItineraryAirport>;
}

export interface FlightRouteEnrichmentResult {
  tracks: AggregatedFlightTrack[];
  warnings: string[];
}

export class FlightRouteEnrichmentService {
  private readonly cache: ManagedResponseCache<LoadedFlightRoutes>;

  constructor(private readonly config: FlightDataConfig) {
    this.cache = new ManagedResponseCache<LoadedFlightRoutes>({
      ttlMs: Math.max(60, config.flightRouteCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.flightRouteCacheTtlSeconds, 60 * 60) * 1000,
      maxEntries: 1
    });
  }

  cacheStats(): ManagedResponseCacheStats {
    return this.cache.stats();
  }

  async enrichTracks(tracks: AggregatedFlightTrack[]): Promise<FlightRouteEnrichmentResult> {
    if (!this.config.flightRouteEnrichmentEnabled || tracks.length === 0) {
      return { tracks, warnings: [] };
    }

    try {
      const reference = await this.loadReference();
      return {
        tracks: tracks.map((track) => this.enrichTrack(track, reference)),
        warnings: []
      };
    } catch (error) {
      return {
        tracks,
        warnings: [error instanceof Error ? `Flight route enrichment unavailable: ${error.message}` : "Flight route enrichment unavailable."]
      };
    }
  }

  private async loadReference(): Promise<LoadedFlightRoutes> {
    return this.cache.getOrLoad("vrs-standing-data:routes-airports", async () => {
      const [routesText, airportsText] = await Promise.all([
        fetchText(this.config.flightRouteRoutesCsvUrl, this.config.requestTimeoutMs),
        fetchText(this.config.flightRouteAirportsCsvUrl, this.config.requestTimeoutMs)
      ]);
      return {
        loadedAt: new Date().toISOString(),
        routes: parseVrsRoutesCsv(routesText),
        ...parseVrsAirportsCsv(airportsText)
      };
    });
  }

  private enrichTrack(track: AggregatedFlightTrack, reference: LoadedFlightRoutes): AggregatedFlightTrack {
    const normalizedCallsign = normalizeCallsign(track.callsign);
    if (!normalizedCallsign) {
      return track;
    }

    const route = reference.routes.get(normalizedCallsign);
    if (!route || route.airportCodes.length < 2) {
      return track;
    }

    const waypoints = route.airportCodes
      .map((code) => reference.airportsByIcao.get(code) ?? reference.airportsByIata.get(code))
      .filter((airport): airport is FlightItineraryAirport => Boolean(airport));
    const origin = waypoints[0];
    const destination = waypoints[waypoints.length - 1];
    const airportIataCodes = route.airportCodes.map((code, index) => waypoints[index]?.iata ?? code);
    const progress = origin && destination ? estimateProgress(track, waypoints) : undefined;
    const estimatedArrivalAt = progress?.estimatedArrivalAt;
    const titleOrigin = origin?.iata ?? origin?.icao ?? route.airportCodes[0];
    const titleDestination = destination?.iata ?? destination?.icao ?? route.airportCodes[route.airportCodes.length - 1];
    const limitations = [
      "Route is matched from open VRS standing data by exact callsign.",
      "Scheduled and actual airport times are not present in the open ADS-B route reference.",
      "ETA is an operational hint estimated from current position, ground speed and great-circle distance; it is not an airline or airport schedule."
    ];

    const itinerary: FlightItinerary = {
      source: {
        sourceId: "vrs_standing_data",
        name: "VRS standing data",
        license: "CC0 1.0",
        routesUrl: this.config.flightRouteRoutesCsvUrl,
        airportsUrl: this.config.flightRouteAirportsCsvUrl
      },
      callsign: route.callsign,
      airlineCode: route.airlineCode,
      flightNumber: route.flightNumber,
      airportCodes: route.airportCodes,
      airportIataCodes,
      origin,
      destination,
      waypoints,
      display: {
        title: `${titleOrigin} -> ${titleDestination}`,
        originCode: titleOrigin,
        destinationCode: titleDestination,
        originCity: origin?.city,
        destinationCity: destination?.city
      },
      progress,
      timing: {
        scheduledDeparture: { status: "unavailable", reason: SCHEDULE_UNAVAILABLE_REASON },
        actualDeparture: { status: "unavailable", reason: SCHEDULE_UNAVAILABLE_REASON },
        scheduledArrival: { status: "unavailable", reason: SCHEDULE_UNAVAILABLE_REASON },
        estimatedArrival: estimatedArrivalAt
          ? {
              status: "estimated",
              value: estimatedArrivalAt,
              basis: "current_position_groundspeed_great_circle",
              confidence: 0.55
            }
          : {
              status: "unavailable",
              confidence: 0,
              reason: track.speedMps && track.speedMps >= MIN_ESTIMATION_SPEED_MPS ? "insufficient_route_geometry" : "missing_or_low_ground_speed"
            }
      },
      quality: {
        routeMatch: "callsign_exact",
        routeConfidence: 0.9,
        scheduleAvailable: false,
        timingMode: estimatedArrivalAt ? "position_estimate" : "unavailable",
        limitations
      }
    };

    return {
      ...track,
      itinerary
    };
  }
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "text/csv,*/*",
      "user-agent": "csm-sim-flight-data/0.1"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return response.text();
}

function parseVrsRoutesCsv(text: string): Map<string, VrsRouteReference> {
  const rows = parseDelimitedRows(text, ",").filter((row) => row.some((cell) => cell.trim().length > 0));
  const headers = rows[0]?.map((header) => header.replace(/^\uFEFF/, "").trim());
  if (!headers) {
    return new Map();
  }
  const indexByHeader = new Map(headers.map((header, index) => [header, index]));
  const routes = new Map<string, VrsRouteReference>();

  for (const row of rows.slice(1)) {
    const callsign = normalizeCallsign(field(row, indexByHeader, "Callsign"));
    const airportCodes = cleanString(field(row, indexByHeader, "AirportCodes"))
      ?.split("-")
      .map((code) => code.trim().toUpperCase())
      .filter((code) => code.length > 0);
    if (!callsign || !airportCodes || airportCodes.length < 2) {
      continue;
    }
    routes.set(callsign, {
      callsign,
      airlineCode: cleanString(field(row, indexByHeader, "AirlineCode"))?.toUpperCase(),
      flightNumber: cleanString(field(row, indexByHeader, "Number")),
      airportCodes
    });
  }

  return routes;
}

function parseVrsAirportsCsv(text: string): Pick<LoadedFlightRoutes, "airportsByIcao" | "airportsByIata"> {
  const rows = parseDelimitedRows(text, ",").filter((row) => row.some((cell) => cell.trim().length > 0));
  const headers = rows[0]?.map((header) => header.replace(/^\uFEFF/, "").trim());
  const airportsByIcao = new Map<string, FlightItineraryAirport>();
  const airportsByIata = new Map<string, FlightItineraryAirport>();
  if (!headers) {
    return { airportsByIcao, airportsByIata };
  }
  const indexByHeader = new Map(headers.map((header, index) => [header, index]));

  for (const row of rows.slice(1)) {
    const icao = cleanString(field(row, indexByHeader, "ICAO"))?.toUpperCase() ?? cleanString(field(row, indexByHeader, "Code"))?.toUpperCase();
    const name = cleanString(field(row, indexByHeader, "Name"));
    const lat = optionalNumber(field(row, indexByHeader, "Latitude"));
    const lon = optionalNumber(field(row, indexByHeader, "Longitude"));
    if (!icao || !name || lat === undefined || lon === undefined) {
      continue;
    }
    const airport: FlightItineraryAirport = {
      icao,
      iata: cleanString(field(row, indexByHeader, "IATA"))?.toUpperCase(),
      name,
      city: cleanString(field(row, indexByHeader, "Location")),
      countryCode: cleanString(field(row, indexByHeader, "CountryISO2"))?.toUpperCase(),
      lat,
      lon,
      elevationFt: optionalNumber(field(row, indexByHeader, "AltitudeFeet"))
    };
    airportsByIcao.set(airport.icao, airport);
    if (airport.iata) {
      airportsByIata.set(airport.iata, airport);
    }
  }

  return { airportsByIcao, airportsByIata };
}

function estimateProgress(track: AggregatedFlightTrack, waypoints: FlightItineraryAirport[]): FlightItinerary["progress"] {
  const origin = waypoints[0];
  const destination = waypoints[waypoints.length - 1];
  if (!origin || !destination) {
    return undefined;
  }

  const totalDistanceKm = roundDistance(polylineDistanceKm(waypoints));
  const distanceRemainingKm = roundDistance(haversineKm(track.lat, track.lon, destination.lat, destination.lon));
  const distanceTravelledKm = roundDistance(Math.max(0, Math.min(totalDistanceKm, totalDistanceKm - distanceRemainingKm)));
  const progressRatio = totalDistanceKm > 0 ? clamp(distanceTravelledKm / totalDistanceKm, 0, 1) : undefined;
  const groundSpeedMps =
    typeof track.speedMps === "number" && Number.isFinite(track.speedMps) && track.speedMps >= MIN_ESTIMATION_SPEED_MPS ? track.speedMps : undefined;
  const estimatedRemainingSeconds = groundSpeedMps ? Math.round((distanceRemainingKm * 1000) / groundSpeedMps) : undefined;
  const lastSeenMs = Date.parse(track.lastSeenAt);
  const estimatedArrivalAt =
    estimatedRemainingSeconds !== undefined && Number.isFinite(lastSeenMs) ? new Date(lastSeenMs + estimatedRemainingSeconds * 1000).toISOString() : undefined;

  return {
    basis: "great_circle_current_position",
    totalDistanceKm,
    distanceTravelledKm,
    distanceRemainingKm,
    progressRatio: progressRatio === undefined ? undefined : round(progressRatio, 4),
    progressPercent: progressRatio === undefined ? undefined : Math.round(progressRatio * 100),
    estimatedRemainingSeconds,
    estimatedArrivalAt,
    groundSpeedMps,
    computedAt: track.lastSeenAt
  };
}

function polylineDistanceKm(waypoints: FlightItineraryAirport[]): number {
  let total = 0;
  for (let index = 1; index < waypoints.length; index += 1) {
    const previous = waypoints[index - 1];
    const current = waypoints[index];
    if (previous && current) {
      total += haversineKm(previous.lat, previous.lon, current.lat, current.lon);
    }
  }
  return total;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === delimiter && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function field(row: string[], indexByHeader: Map<string, number>, name: string): string | undefined {
  const index = indexByHeader.get(name);
  return index === undefined ? undefined : row[index];
}

function normalizeCallsign(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, "").trim().toUpperCase();
  return cleaned ? cleaned : undefined;
}

function cleanString(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function roundDistance(value: number): number {
  return round(value, 1);
}

function round(value: number, precision: number): number {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
