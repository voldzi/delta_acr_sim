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
      },
      {
        providerLayerId: "flight.airspaces",
        recommendedCatalogLayerId: "flight.reference.airspaces",
        label: "Letecké prostory",
        description: "Referenční zakázané, omezené a nebezpečné prostory z AIP/eAIP ENR 5.1. Vrstva je určena pro situační přehled, ne pro navigaci.",
        categoryPath: ["flight", "reference", "airspaces"],
        categories: ["airspace", "prohibited_area", "restricted_area", "danger_area"],
        role: "reference",
        audience: "public",
        kind: "static_reference",
        defaultVisible: false,
        selectable: true,
        geometryTypes: ["Polygon"],
        minZoom: 6,
        maxZoom: 18,
        refreshSeconds: config.aipAirspacesCacheTtlSeconds,
        cacheTtlSeconds: config.aipAirspacesCacheTtlSeconds,
        styleProfile: "airspace-reference-v1",
        sourceIds: ["czech_aip_airspaces"],
        filters: [
          {
            filterId: "type",
            label: "Typ prostoru",
            type: "multi_select",
            values: ["prohibited", "restricted", "danger", "temporary_reserved", "temporary_segregated", "other"],
            defaultValue: ["prohibited", "restricted", "danger"]
          }
        ],
        query: {
          mode: "bbox",
          providerId: PROVIDER_ID,
          streamId: "airspaces",
          providerLayerIds: ["flight.airspaces"],
          providerSourceIds: ["czech_aip_airspaces"],
          maxFeatures: 1000
        },
        legal: {
          attribution: "Air Navigation Services of the Czech Republic / AIP CR.",
          notes: [
            "Reference layer only; not for navigation.",
            "Commercial or operational redistribution should be validated with AIS/ANS CR or replaced by a licensed AIXM/AIP feed.",
            "DroneMap UAS geographical zones are not republished because its terms restrict public redistribution without written consent."
          ]
        }
      },
      {
        providerLayerId: "flight.uas_geozones",
        recommendedCatalogLayerId: "flight.reference.uas_geozones",
        label: "UAS zeměpisné zóny",
        description: "Referenční zeměpisné zóny pro bezpilotní systémy z oficiálních AIM/ŘLP JSON datových sad.",
        categoryPath: ["flight", "reference", "uas-geozones"],
        categories: ["uas_geozone", "geoawareness", "restricted_area"],
        role: "reference",
        audience: "public",
        kind: "static_reference",
        defaultVisible: false,
        selectable: true,
        geometryTypes: ["Polygon", "MultiPolygon"],
        minZoom: 7,
        maxZoom: 18,
        refreshSeconds: config.uasGeozonesCacheTtlSeconds,
        cacheTtlSeconds: config.uasGeozonesCacheTtlSeconds,
        styleProfile: "uas-geozone-reference-v1",
        sourceIds: ["czech_uas_geozones"],
        filters: [
          {
            filterId: "publication",
            label: "Datová sada",
            type: "multi_select",
            values: config.uasGeozonesLayerIds,
            defaultValue: config.uasGeozonesLayerIds
          }
        ],
        query: {
          mode: "bbox",
          providerId: PROVIDER_ID,
          streamId: "uas.geozones",
          providerLayerIds: ["flight.uas_geozones"],
          providerSourceIds: ["czech_uas_geozones"],
          maxFeatures: 1000
        },
        legal: {
          attribution: "Řízení letového provozu České republiky, s.p. / AIM.",
          notes: [
            "Reference layer for UAS geoawareness, not a replacement for pre-flight planning.",
            "The default import intentionally avoids very large AIM packages; broaden UAS_GEOZONES_LAYER_IDS only with cache/tile capacity sized for it."
          ]
        }
      },
      {
        providerLayerId: "flight.airspace_activation",
        recommendedCatalogLayerId: "flight.airspace.activation",
        label: "Aktivace vzdušných prostorů",
        description: "Aktuální plánovaná a aktualizovaná aktivace TRA/TSA prostorů z AUP/UUP ŘLP, promítnutá na dostupnou geometrii UAS/AIM zón.",
        categoryPath: ["flight", "airspace", "activation"],
        categories: ["airspace_activation", "aup", "uup"],
        role: "overlay",
        audience: "public",
        kind: "vector_features",
        defaultVisible: false,
        selectable: true,
        geometryTypes: ["Polygon", "MultiPolygon"],
        minZoom: 6,
        maxZoom: 18,
        refreshSeconds: config.airspaceActivationCacheTtlSeconds,
        cacheTtlSeconds: config.airspaceActivationCacheTtlSeconds,
        styleProfile: "airspace-activation-v1",
        sourceIds: ["czech_aup_uup"],
        query: {
          mode: "bbox",
          providerId: PROVIDER_ID,
          streamId: "airspace.activations",
          providerLayerIds: ["flight.airspace_activation"],
          providerSourceIds: ["czech_aup_uup"],
          maxFeatures: 1000
        },
        legal: {
          attribution: "Řízení letového provozu České republiky, s.p. / AUP/UUP.",
          notes: ["Situational activation overview only; NOTAM/AUP/UUP source documents remain authoritative."]
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
      },
      {
        sourceId: "czech_aip_airspaces",
        label: "Czech AIP/eAIP ENR 5.1 airspace reference",
        enabled: config.aipAirspacesEnabled,
        mode: "reference",
        sourceRole: "reference",
        audience: "public",
        selectableInMap: false,
        visibleInDiagnostics: true,
        feedsLayerIds: ["flight.airspaces"],
        feedsCatalogLayerIds: ["flight.reference.airspaces"],
        updateCadenceSeconds: config.aipAirspacesCacheTtlSeconds,
        cacheTtlSeconds: config.aipAirspacesCacheTtlSeconds,
        baseUrl: config.aipAirspacesSourceUrl,
        license: {
          name: "Public AIP/eAIP publication; redistribution rights must be validated",
          attribution: "Air Navigation Services of the Czech Republic / AIP CR",
          commercialUse: "requires_license",
          operationalUse: "requires_license",
          notes: [
            "Use as public situational reference only, not as operational aeronautical information.",
            "Production/commercial redistribution should be confirmed with AIS/ANS CR."
          ]
        },
        notes: ["Cache-backed reference source for restricted/prohibited/danger airspaces."]
      },
      {
        sourceId: "czech_uas_geozones",
        label: "AIM/ANS CR UAS geographical zones",
        enabled: config.uasGeozonesEnabled,
        mode: "reference",
        sourceRole: "reference",
        audience: "public",
        selectableInMap: false,
        visibleInDiagnostics: true,
        feedsLayerIds: ["flight.uas_geozones"],
        feedsCatalogLayerIds: ["flight.reference.uas_geozones"],
        updateCadenceSeconds: config.uasGeozonesCacheTtlSeconds,
        cacheTtlSeconds: config.uasGeozonesCacheTtlSeconds,
        baseUrl: config.uasGeozonesCatalogUrl,
        license: {
          name: "AIM/ANS CR UAS geographical zone dataset terms",
          attribution: "Řízení letového provozu České republiky, s.p. / AIM",
          commercialUse: "allowed_with_obligations",
          operationalUse: "allowed_with_obligations",
          notes: ["Preserve attribution and dataset validity metadata.", "Use reference GeoJSON files for precise UAS geographical zone boundaries."]
        },
        notes: ["Configured imported layers: " + config.uasGeozonesLayerIds.join(", ")]
      },
      {
        sourceId: "czech_aup_uup",
        label: "ANS CR AUP/UUP airspace activation",
        enabled: config.airspaceActivationEnabled,
        mode: "live",
        sourceRole: "reference",
        audience: "public",
        selectableInMap: false,
        visibleInDiagnostics: true,
        feedsLayerIds: ["flight.airspace_activation"],
        feedsCatalogLayerIds: ["flight.airspace.activation"],
        technicalInputs: ["czech_uas_geozones"],
        updateCadenceSeconds: config.airspaceActivationCacheTtlSeconds,
        cacheTtlSeconds: config.airspaceActivationCacheTtlSeconds,
        baseUrl: config.airspaceActivationBaseUrl,
        license: {
          name: "ANS CR AUP/UUP publication terms",
          attribution: "Řízení letového provozu České republiky, s.p. / AUP/UUP",
          commercialUse: "allowed_with_obligations",
          operationalUse: "allowed_with_obligations",
          notes: ["AUP/UUP source documents remain authoritative.", "Geometry matching depends on the imported AIM UAS geozone datasets."]
        },
        notes: ["Dynamic activation overlay matched to available geozone geometry."]
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
