import type { AircraftTypeReference, AirportReference, BoundingBox } from "./types.js";
import type { FlightDataConfig } from "./config.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";

export interface ReferenceDataMetadata {
  airportCount: number;
  airportSource: string;
  loadedAt?: string;
  warnings: string[];
  cache: ManagedResponseCacheStats;
}

export const airportReferences: AirportReference[] = [
  {
    ident: "LKPR",
    iata: "PRG",
    name: "Vaclav Havel Airport Prague",
    municipality: "Prague",
    countryCode: "CZ",
    type: "large_airport",
    lat: 50.1008,
    lon: 14.2632,
    elevationFt: 1247,
    dataSource: "seed:ourairports-compatible"
  },
  {
    ident: "LKKB",
    name: "Kbely Air Base",
    municipality: "Prague",
    countryCode: "CZ",
    type: "medium_airport",
    lat: 50.1214,
    lon: 14.5436,
    elevationFt: 939,
    dataSource: "seed:ourairports-compatible"
  },
  {
    ident: "LKVO",
    name: "Vodochody Airport",
    municipality: "Vodochody",
    countryCode: "CZ",
    type: "medium_airport",
    lat: 50.2166,
    lon: 14.3958,
    elevationFt: 919,
    dataSource: "seed:ourairports-compatible"
  },
  {
    ident: "LKCV",
    name: "Caslav Air Base",
    municipality: "Caslav",
    countryCode: "CZ",
    type: "medium_airport",
    lat: 49.9397,
    lon: 15.3818,
    elevationFt: 794,
    dataSource: "seed:ourairports-compatible"
  },
  {
    ident: "LKPD",
    iata: "PED",
    name: "Pardubice Airport",
    municipality: "Pardubice",
    countryCode: "CZ",
    type: "medium_airport",
    lat: 50.0134,
    lon: 15.7386,
    elevationFt: 741,
    dataSource: "seed:ourairports-compatible"
  },
  {
    ident: "LKTB",
    iata: "BRQ",
    name: "Brno-Turany Airport",
    municipality: "Brno",
    countryCode: "CZ",
    type: "medium_airport",
    lat: 49.1513,
    lon: 16.6944,
    elevationFt: 778,
    dataSource: "seed:ourairports-compatible"
  },
  {
    ident: "LOWW",
    iata: "VIE",
    name: "Vienna International Airport",
    municipality: "Vienna",
    countryCode: "AT",
    type: "large_airport",
    lat: 48.1103,
    lon: 16.5697,
    elevationFt: 600,
    dataSource: "seed:ourairports-compatible"
  },
  {
    ident: "EDDM",
    iata: "MUC",
    name: "Munich Airport",
    municipality: "Munich",
    countryCode: "DE",
    type: "large_airport",
    lat: 48.3538,
    lon: 11.7861,
    elevationFt: 1487,
    dataSource: "seed:ourairports-compatible"
  }
];

export const aircraftTypeReferences: AircraftTypeReference[] = [
  {
    designator: "A319",
    manufacturer: "Airbus",
    model: "A319",
    category: "LandPlane",
    engineType: "Jet",
    wakeTurbulenceCategory: "Medium",
    dataSource: "seed:icao-doc8643-compatible"
  },
  {
    designator: "A320",
    manufacturer: "Airbus",
    model: "A320",
    category: "LandPlane",
    engineType: "Jet",
    wakeTurbulenceCategory: "Medium",
    dataSource: "seed:icao-doc8643-compatible"
  },
  {
    designator: "A321",
    manufacturer: "Airbus",
    model: "A321",
    category: "LandPlane",
    engineType: "Jet",
    wakeTurbulenceCategory: "Medium",
    dataSource: "seed:icao-doc8643-compatible"
  },
  {
    designator: "B738",
    manufacturer: "Boeing",
    model: "737-800",
    category: "LandPlane",
    engineType: "Jet",
    wakeTurbulenceCategory: "Medium",
    dataSource: "seed:icao-doc8643-compatible"
  },
  {
    designator: "B789",
    manufacturer: "Boeing",
    model: "787-9",
    category: "LandPlane",
    engineType: "Jet",
    wakeTurbulenceCategory: "Heavy",
    dataSource: "seed:icao-doc8643-compatible"
  },
  {
    designator: "B77W",
    manufacturer: "Boeing",
    model: "777-300ER",
    category: "LandPlane",
    engineType: "Jet",
    wakeTurbulenceCategory: "Heavy",
    dataSource: "seed:icao-doc8643-compatible"
  },
  {
    designator: "E190",
    manufacturer: "Embraer",
    model: "190",
    category: "LandPlane",
    engineType: "Jet",
    wakeTurbulenceCategory: "Medium",
    dataSource: "seed:icao-doc8643-compatible"
  },
  {
    designator: "AT72",
    manufacturer: "ATR",
    model: "72",
    category: "LandPlane",
    engineType: "Turboprop",
    wakeTurbulenceCategory: "Medium",
    dataSource: "seed:icao-doc8643-compatible"
  },
  {
    designator: "C172",
    manufacturer: "Cessna",
    model: "172",
    category: "LandPlane",
    engineType: "Piston",
    wakeTurbulenceCategory: "Light",
    dataSource: "seed:icao-doc8643-compatible"
  },
  {
    designator: "DA42",
    manufacturer: "Diamond",
    model: "DA42",
    category: "LandPlane",
    engineType: "Piston",
    wakeTurbulenceCategory: "Light",
    dataSource: "seed:icao-doc8643-compatible"
  },
  {
    designator: "H60",
    manufacturer: "Sikorsky",
    model: "H-60",
    category: "Helicopter",
    engineType: "Turboshaft",
    wakeTurbulenceCategory: "Medium",
    dataSource: "seed:icao-doc8643-compatible"
  }
];

export class ReferenceDataService {
  private readonly airportsCache: ManagedResponseCache<LoadedAirports>;

  constructor(private readonly config: FlightDataConfig) {
    this.airportsCache = new ManagedResponseCache<LoadedAirports>({
      ttlMs: Math.max(60, config.ourAirportsCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.ourAirportsCacheTtlSeconds, 60 * 60) * 1000,
      maxEntries: 1
    });
  }

  async searchAirports(query: string | undefined, bbox: BoundingBox | undefined, limit: number): Promise<AirportReference[]> {
    return filterAirports((await this.loadAirports()).airports, query, bbox, limit);
  }

  async getAirport(ident: string): Promise<AirportReference | undefined> {
    const normalized = ident.trim().toUpperCase();
    return (await this.loadAirports()).airports.find((airport) => airport.ident === normalized || airport.iata === normalized);
  }

  async metadata(): Promise<ReferenceDataMetadata> {
    const loaded = await this.loadAirports();
    return {
      airportCount: loaded.airports.length,
      airportSource: loaded.source,
      loadedAt: loaded.loadedAt,
      warnings: loaded.warnings,
      cache: this.airportsCache.stats()
    };
  }

  private async loadAirports(): Promise<LoadedAirports> {
    if (!this.config.ourAirportsEnabled) {
      return {
        airports: airportReferences,
        source: "seed:ourairports-compatible",
        loadedAt: new Date().toISOString(),
        warnings: ["OurAirports import is disabled; using embedded seed airports."]
      };
    }

    return this.airportsCache.getOrLoad("ourairports:airports.csv", async () => {
      try {
        const response = await fetch(this.config.ourAirportsCsvUrl, {
          headers: {
            accept: "text/csv,*/*",
            "user-agent": "csm-sim-flight-data/0.1"
          },
          signal: AbortSignal.timeout(this.config.requestTimeoutMs)
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from ${new URL(this.config.ourAirportsCsvUrl).hostname}`);
        }
        const parsed = parseOurAirportsCsv(await response.text(), new Set(this.config.ourAirportsCountries.map((item) => item.toUpperCase())));
        const airports = mergeAirports(parsed, airportReferences);
        return {
          airports: airports.length > 0 ? airports : airportReferences,
          source: airports.length > 0 ? "ourairports:airports.csv" : "seed:ourairports-compatible",
          loadedAt: new Date().toISOString(),
          warnings: airports.length > 0 ? [] : ["OurAirports import returned no usable airports; using embedded seed airports."]
        };
      } catch (error) {
        return {
          airports: airportReferences,
          source: "seed:ourairports-compatible",
          loadedAt: new Date().toISOString(),
          warnings: [error instanceof Error ? `OurAirports import failed: ${error.message}` : "OurAirports import failed."]
        };
      }
    });
  }
}

interface LoadedAirports {
  airports: AirportReference[];
  source: string;
  loadedAt: string;
  warnings: string[];
}

export function searchAirports(query: string | undefined, bbox: BoundingBox | undefined, limit: number): AirportReference[] {
  return filterAirports(airportReferences, query, bbox, limit);
}

function filterAirports(airports: AirportReference[], query: string | undefined, bbox: BoundingBox | undefined, limit: number): AirportReference[] {
  const normalized = query?.trim().toLowerCase();
  return airports
    .filter((airport) => {
      const matchesQuery =
        !normalized ||
        airport.ident.toLowerCase().includes(normalized) ||
        airport.iata?.toLowerCase().includes(normalized) ||
        airport.name.toLowerCase().includes(normalized) ||
        airport.municipality?.toLowerCase().includes(normalized);
      return matchesQuery && (!bbox || isInBbox(airport.lat, airport.lon, bbox));
    })
    .sort(compareAirports)
    .slice(0, limit);
}

export function getAirport(ident: string): AirportReference | undefined {
  const normalized = ident.trim().toUpperCase();
  return airportReferences.find((airport) => airport.ident === normalized || airport.iata === normalized);
}

export function searchAircraftTypes(query: string | undefined, limit: number): AircraftTypeReference[] {
  const normalized = query?.trim().toLowerCase();
  return aircraftTypeReferences
    .filter(
      (type) =>
        !normalized ||
        type.designator.toLowerCase().includes(normalized) ||
        type.manufacturer.toLowerCase().includes(normalized) ||
        type.model.toLowerCase().includes(normalized)
    )
    .slice(0, limit);
}

export function getAircraftType(designator: string | undefined): AircraftTypeReference | undefined {
  if (!designator) {
    return undefined;
  }
  const normalized = designator.trim().toUpperCase();
  return aircraftTypeReferences.find((type) => type.designator === normalized);
}

function isInBbox(lat: number, lon: number, bbox: BoundingBox): boolean {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function parseOurAirportsCsv(text: string, allowedCountries: Set<string>): AirportReference[] {
  const rows = parseDelimitedRows(text, ",").filter((row) => row.some((cell) => cell.trim().length > 0));
  const headers = rows[0]?.map((header) => header.replace(/^\uFEFF/, "").trim());
  if (!headers) {
    return [];
  }
  const indexByHeader = new Map(headers.map((header, index) => [header, index]));
  const airports: AirportReference[] = [];
  for (const row of rows.slice(1)) {
    const countryCode = field(row, indexByHeader, "iso_country")?.toUpperCase();
    if (!countryCode || !allowedCountries.has(countryCode)) {
      continue;
    }
    const type = parseAirportType(field(row, indexByHeader, "type"));
    if (!type) {
      continue;
    }
    const lat = optionalNumber(field(row, indexByHeader, "latitude_deg"));
    const lon = optionalNumber(field(row, indexByHeader, "longitude_deg"));
    const ident =
      cleanString(field(row, indexByHeader, "icao_code")) ??
      cleanString(field(row, indexByHeader, "gps_code")) ??
      cleanString(field(row, indexByHeader, "ident"));
    const name = cleanString(field(row, indexByHeader, "name"));
    if (!ident || !name || lat === undefined || lon === undefined) {
      continue;
    }
    airports.push({
      ident: ident.toUpperCase(),
      iata: cleanString(field(row, indexByHeader, "iata_code"))?.toUpperCase(),
      name,
      municipality: cleanString(field(row, indexByHeader, "municipality")),
      countryCode,
      type,
      lat,
      lon,
      elevationFt: optionalNumber(field(row, indexByHeader, "elevation_ft")),
      dataSource: "ourairports:airports.csv"
    });
  }
  return airports;
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

function mergeAirports(primary: AirportReference[], fallback: AirportReference[]): AirportReference[] {
  const merged = new Map<string, AirportReference>();
  for (const airport of fallback) {
    merged.set(airport.ident, airport);
  }
  for (const airport of primary) {
    merged.set(airport.ident, airport);
  }
  return Array.from(merged.values());
}

function compareAirports(a: AirportReference, b: AirportReference): number {
  const typeDelta = airportRank(a.type) - airportRank(b.type);
  if (typeDelta !== 0) {
    return typeDelta;
  }
  return a.ident.localeCompare(b.ident);
}

function airportRank(type: AirportReference["type"]): number {
  switch (type) {
    case "large_airport":
      return 1;
    case "medium_airport":
      return 2;
    case "small_airport":
      return 3;
    case "heliport":
      return 4;
    case "seaplane_base":
      return 5;
    case "balloonport":
      return 6;
    case "closed_airport":
    default:
      return 7;
  }
}

function field(row: string[], indexByHeader: Map<string, number>, name: string): string | undefined {
  const index = indexByHeader.get(name);
  return index === undefined ? undefined : row[index];
}

function parseAirportType(value: string | undefined): AirportReference["type"] | undefined {
  const normalized = value?.trim();
  switch (normalized) {
    case "large_airport":
    case "medium_airport":
    case "small_airport":
    case "heliport":
    case "closed_airport":
    case "seaplane_base":
    case "balloonport":
      return normalized;
    default:
      return undefined;
  }
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
