import type { AircraftTypeReference, AirportReference, BoundingBox } from "./types.js";

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

export function searchAirports(query: string | undefined, bbox: BoundingBox | undefined, limit: number): AirportReference[] {
  const normalized = query?.trim().toLowerCase();
  return airportReferences
    .filter((airport) => {
      const matchesQuery =
        !normalized ||
        airport.ident.toLowerCase().includes(normalized) ||
        airport.iata?.toLowerCase().includes(normalized) ||
        airport.name.toLowerCase().includes(normalized) ||
        airport.municipality?.toLowerCase().includes(normalized);
      return matchesQuery && (!bbox || isInBbox(airport.lat, airport.lon, bbox));
    })
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
