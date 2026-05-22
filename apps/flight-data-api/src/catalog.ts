import type { FlightDataConfig } from "./config.js";
import { allSourceDescriptors } from "./sources.js";
import type { FlightDataSourceId, SourceDescriptor } from "./types.js";

const PROVIDER_ID = "sim.flight-data" as const;
const MAP_CATALOG_DOCUMENT = "https://github.com/voldzi/delta_acr_sim/blob/main/docs/provider/02_MAP_CATALOG_PROVIDER_CONTRACT.md";

export function buildFlightMapCatalog(config: FlightDataConfig, generatedAt = new Date().toISOString()) {
  const descriptors = allSourceDescriptors(config);
  return {
    contractVersion: "provider-map-catalog-v1",
    catalogVersion: "provider-map-catalog-v1",
    providerId: PROVIDER_ID,
    generatedAt,
    status: "online",
    authority: {
      contractVersion: "map-catalog-v1",
      catalogVersion: "map-catalog-v1",
      document: MAP_CATALOG_DOCUMENT
    },
    layers: [
      {
        providerLayerId: "flight.tracks",
        recommendedCatalogLayerId: "flight.public.tracks",
        label: "Letecké tracky",
        description: "Deduplicované polohy letadel podle icao24 z povolených veřejných nebo partnerských ADS-B zdrojů.",
        categoryPath: ["flight", "tracks"],
        categories: ["aircraft_track", "flight"],
        role: "overlay",
        audience: "public",
        kind: "track_stream",
        defaultVisible: false,
        selectable: true,
        geometryTypes: ["Point"],
        minZoom: 4,
        maxZoom: 18,
        refreshSeconds: config.cacheTtlSeconds,
        cacheTtlSeconds: config.cacheTtlSeconds,
        styleProfile: "flight-track-v1",
        sourceIds: ["adsb_lol", "opensky", "local_adsb"],
        query: {
          mode: "bbox",
          providerId: PROVIDER_ID,
          streamId: "aircraft.positions",
          providerLayerIds: ["flight.tracks"],
          providerSourceIds: ["adsb_lol", "opensky", "local_adsb"],
          maxFeatures: 500
        },
        legal: {
          attribution: "Feature-level source attribution is preserved from ADS-B/OpenSky/local receiver sources.",
          notes: ["Flight positions are situational context and can be delayed, incomplete or license-restricted."]
        }
      },
      {
        providerLayerId: "flight.airports",
        recommendedCatalogLayerId: "flight.reference.airports",
        label: "Letiště",
        description: "Referenční letiště z OurAirports nebo lokální seed databáze.",
        categoryPath: ["flight", "reference", "airports"],
        categories: ["airport", "heliport"],
        role: "reference",
        audience: "public",
        kind: "static_reference",
        defaultVisible: false,
        selectable: true,
        geometryTypes: ["Point"],
        minZoom: 5,
        maxZoom: 18,
        refreshSeconds: config.ourAirportsCacheTtlSeconds,
        cacheTtlSeconds: config.ourAirportsCacheTtlSeconds,
        styleProfile: "airport-reference-v1",
        sourceIds: ["ourairports"],
        query: {
          mode: "bbox",
          providerId: PROVIDER_ID,
          streamId: "airports",
          providerLayerIds: ["flight.airports"],
          providerSourceIds: ["ourairports"],
          maxFeatures: 500
        },
        legal: {
          attribution: "OurAirports public domain data where imported; embedded seed is public-domain compatible.",
          notes: ["Reference data only; not an operational aeronautical information publication."]
        }
      }
    ],
    sources: [
      ...descriptors.map((descriptor) => providerSource(descriptor, config)),
      {
        sourceId: "ourairports",
        label: "OurAirports reference data",
        enabled: config.ourAirportsEnabled,
        mode: "reference",
        sourceRole: "reference",
        audience: "public",
        selectableInMap: false,
        visibleInDiagnostics: true,
        feedsLayerIds: ["flight.airports"],
        feedsCatalogLayerIds: ["flight.reference.airports"],
        updateCadenceSeconds: config.ourAirportsCacheTtlSeconds,
        cacheTtlSeconds: config.ourAirportsCacheTtlSeconds,
        license: {
          name: "Public domain",
          attribution: "OurAirports",
          commercialUse: "allowed",
          operationalUse: "allowed_with_obligations",
          notes: ["Verify operational aviation use against official AIP/AIS sources."]
        },
        notes: ["Reference source, not a live track feed."]
      }
    ]
  };
}

function providerSource(descriptor: SourceDescriptor, config: FlightDataConfig) {
  const role = sourceRole(descriptor.sourceId);
  return {
    sourceId: descriptor.sourceId,
    label: descriptor.label,
    enabled: descriptor.enabled,
    mode: descriptor.mode,
    sourceRole: role.sourceRole,
    audience: role.audience,
    selectableInMap: role.selectableInMap,
    visibleInDiagnostics: true,
    feedsLayerIds: role.feedsLayerIds,
    feedsCatalogLayerIds: role.feedsCatalogLayerIds,
    updateCadenceSeconds: config.cacheTtlSeconds,
    cacheTtlSeconds: config.cacheTtlSeconds,
    baseUrl: descriptor.baseUrl,
    license: descriptor.license,
    notes: role.notes
  };
}

function sourceRole(sourceId: FlightDataSourceId) {
  switch (sourceId) {
    case "mock":
      return {
        sourceRole: "mock",
        audience: "diagnostic",
        selectableInMap: false,
        feedsLayerIds: [],
        feedsCatalogLayerIds: [],
        notes: ["Synthetic data source for tests only."]
      };
    case "adsb_lol":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: false,
        feedsLayerIds: ["flight.tracks"],
        feedsCatalogLayerIds: ["flight.public.tracks"],
        notes: ["Public ADS-B source; respect ODbL attribution and redistribution obligations."]
      };
    case "opensky":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: false,
        feedsLayerIds: ["flight.tracks"],
        feedsCatalogLayerIds: ["flight.public.tracks"],
        notes: ["OpenSky use can require permission for commercial or operational use."]
      };
    case "local_adsb":
      return {
        sourceRole: "final",
        audience: "public",
        selectableInMap: false,
        feedsLayerIds: ["flight.tracks"],
        feedsCatalogLayerIds: ["flight.public.tracks"],
        notes: ["Preferred production path for project-owned or partner-authorized receivers."]
      };
  }
}
