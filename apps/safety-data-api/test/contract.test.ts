import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SafetyAggregationService } from "../src/aggregation.js";
import { createApp } from "../src/app.js";
import type { SafetyDataConfig } from "../src/config.js";
import type { SafetyDataSource } from "../src/sources.js";

describe("Safety Data API contract", () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let config: SafetyDataConfig;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "delta-acr-safety-data-"));
    config = {
      port: 0,
      dataDir,
      enabledSources: ["mock"],
      defaultBbox: { west: 13.85, south: 49.65, east: 15.35, north: 50.45 },
      requestTimeoutMs: 1000,
      cacheTtlSeconds: 1,
      staleIfErrorSeconds: 600,
      cacheMaxEntries: 128,
      staleAfterSeconds: 900,
      chmiAlertsCapBaseUrl: "https://opendata.chmi.cz/meteorology/weather/alerts/cap/",
      chmiHydroMetadataUrl: "https://opendata.chmi.cz/hydrology/historical/metadata/meta1.json",
      chmiHydroNowBaseUrl: "https://opendata.chmi.cz/hydrology/now/data",
      chmiHydroMaxStations: 20
    };
    ({ app } = await createApp(config));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("exposes health, layers and source metadata", async () => {
    const health = await request(app).get("/health/ready").expect(200);
    expect(health.body.status).toBe("ok");
    expect(health.body.enabledSources).toEqual(["mock"]);

    const layers = await request(app).get("/api/v1/layers").expect(200);
    expect(layers.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layerId: "warnings", defaultVisible: true }),
        expect.objectContaining({ layerId: "flood", defaultVisible: true })
      ])
    );

    const sources = await request(app).get("/api/v1/sources").expect(200);
    expect(sources.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "mock",
          enabled: true,
          layers: expect.arrayContaining(["warnings", "flood"])
        }),
        expect.objectContaining({
          sourceId: "chmi_alerts",
          license: expect.objectContaining({ name: "CHMI Open Data" })
        }),
        expect.objectContaining({
          sourceId: "chmi_hydro",
          layers: expect.arrayContaining(["flood"])
        })
      ])
    );
  });

  it("exposes non-secret runtime configuration", async () => {
    const response = await request(app).get("/api/v1/config").expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        enabledSources: ["mock"],
        defaultBbox: { west: 13.85, south: 49.65, east: 15.35, north: 50.45 },
        cacheTtlSeconds: 1,
        staleIfErrorSeconds: 600,
        cacheMaxEntries: 128,
        staleAfterSeconds: 900,
        hydroMaxStations: 20,
        providers: expect.arrayContaining([
          expect.objectContaining({ sourceId: "mock", authConfigured: true }),
          expect.objectContaining({ sourceId: "chmi_alerts", authConfigured: true }),
          expect.objectContaining({ sourceId: "chmi_hydro", authConfigured: true })
        ])
      })
    );
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("exposes provider map catalog metadata for COM", async () => {
    const response = await request(app).get("/api/v1/catalog").expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        contractVersion: "provider-map-catalog-v1",
        catalogVersion: "provider-map-catalog-v1",
        providerId: "sim.safety-data",
        status: "online",
        authority: expect.objectContaining({
          contractVersion: "map-catalog-v1",
          document: expect.stringContaining("02_MAP_CATALOG_PROVIDER_CONTRACT.md")
        })
      })
    );
    expect(response.body.layers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerLayerId: "safety.warnings",
          recommendedCatalogLayerId: "public.safety.warnings",
          categories: expect.arrayContaining(["warning"]),
          role: "overlay",
          sourceIds: ["chmi_alerts"]
        }),
        expect.objectContaining({
          providerLayerId: "safety.flood",
          recommendedCatalogLayerId: "public.safety.flood",
          categories: expect.arrayContaining(["hydrology"]),
          role: "overlay",
          sourceIds: ["chmi_hydro"]
        })
      ])
    );
    expect(response.body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "chmi_alerts",
          sourceRole: "final",
          feedsLayerIds: ["safety.warnings"],
          feedsCatalogLayerIds: ["public.safety.warnings"]
        }),
        expect.objectContaining({
          sourceId: "chmi_hydro",
          sourceRole: "final",
          feedsLayerIds: ["safety.flood"],
          feedsCatalogLayerIds: ["public.safety.flood"]
        })
      ])
    );
  });

  it("exposes cache metrics", async () => {
    const response = await request(app).get("/metrics").expect(200);
    expect(response.text).toContain("safety_data_cache_entries");
    expect(response.text).toContain("safety_data_cache_coalesced_hits");
  });

  it("skips CHMI hydro stations with missing current data without degrading a partial response", async () => {
    await withFixtureServer(
      {
        "/meta.json": JSON.stringify(chmiHydroMetadataFixture()),
        "/now/0-203-1-good.json": JSON.stringify(chmiHydroNowFixture("0-203-1-good")),
        "/now/0-203-1-missing.json": { status: 404, body: "not found" }
      },
      async (baseUrl) => {
        const configured = await createApp({
          ...config,
          enabledSources: ["chmi_hydro"],
          chmiHydroMetadataUrl: `${baseUrl}/meta.json`,
          chmiHydroNowBaseUrl: `${baseUrl}/now`
        });

        const response = await request(configured.app)
          .get("/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=flood&source=chmi_hydro&limit=10")
          .expect(200);

        expect(response.body.summary.featureCount).toBe(1);
        expect(response.body.warnings).toEqual([]);
        expect(response.body.features[0].properties.tags.stationId).toBe("0-203-1-good");
      }
    );
  });

  it("does not publish inactive CHMI CAP no-warning entries as stale warnings", async () => {
    await withFixtureServer(
      {
        "/cap/": '<html><body><a href="alert.xml">alert.xml</a> 20-May-2026 10:09</body></html>',
        "/cap/alert.xml": chmiNoWarningCapFixture()
      },
      async (baseUrl) => {
        const configured = await createApp({
          ...config,
          enabledSources: ["chmi_alerts"],
          chmiAlertsCapBaseUrl: `${baseUrl}/cap/`
        });

        const response = await request(configured.app)
          .get("/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=warnings&source=chmi_alerts&limit=10")
          .expect(200);

        expect(response.body.summary.featureCount).toBe(0);
        expect(response.body.summary.staleFeatureCount).toBe(0);
        expect(response.body.warnings).toEqual([]);
      }
    );
  });

  it("returns the COP GeoJSON projection", async () => {
    const response = await request(app)
      .get("/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=warnings,flood&source=mock&limit=20")
      .expect(200);

    expect(response.body.contractVersion).toBe("cop-safety-source-v1");
    expect(response.body.type).toBe("FeatureCollection");
    expect(response.body.source.sourceType).toBe("PUBLIC_SAFETY_AGGREGATE");
    expect(response.body.summary.featureCount).toBeGreaterThan(0);
    expect(response.body.features[0]).toEqual(
      expect.objectContaining({
        type: "Feature",
        id: expect.any(String),
        geometry: expect.objectContaining({ type: "Point" }),
        properties: expect.objectContaining({
          featureId: expect.any(String),
          layerId: expect.stringMatching(/^public\.safety\./),
          providerId: "sim.safety-data",
          providerLayerId: expect.stringMatching(/^safety\./),
          sourceId: "mock",
          confidence: expect.any(Number),
          stale: false,
          license: expect.objectContaining({ attribution: "DELTA ACR SIM" })
        })
      })
    );
  });

  it("filters by layer", async () => {
    const response = await request(app).get("/api/v1/features?layers=flood&source=mock").expect(200);

    expect(response.body.features.length).toBeGreaterThan(0);
    expect(response.body.features.every((feature: { properties: { layer: string } }) => feature.properties.layer === "flood")).toBe(true);
  });

  it("keeps layers represented when a low limit is requested", async () => {
    const response = await request(app).get("/api/v1/features?layers=warnings,flood&source=mock&limit=2").expect(200);

    const layers = new Set(response.body.features.map((feature: { properties: { layer: string } }) => feature.properties.layer));
    expect(layers).toEqual(new Set(["warnings", "flood"]));
  });

  it("validates bbox and layers", async () => {
    const bbox = await request(app).get("/api/v1/features?bbox=bad").expect(400);
    expect(bbox.body.error.code).toBe("VALIDATION_ERROR");

    const layers = await request(app).get("/api/v1/features?layers=unknown").expect(400);
    expect(layers.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("coalesces concurrent cache misses into one source fetch", async () => {
    let calls = 0;
    const descriptor: SafetyDataSource["descriptor"] = {
      sourceId: "mock",
      label: "test",
      enabled: true,
      mode: "mock",
      priority: 10,
      layers: ["warnings"],
      license: {
        name: "test",
        attribution: "test",
        commercialUse: "allowed",
        operationalUse: "allowed",
        notes: []
      }
    };
    const source: SafetyDataSource = {
      descriptor,
      async fetchFeatures() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        const fetchedAt = new Date().toISOString();
        return {
          source: descriptor,
          fetchedAt,
          warnings: [],
          features: [
            {
              type: "Feature",
              id: "warnings:test",
              geometry: { type: "Point", coordinates: [14.4, 50.1] },
              properties: {
                featureId: "warnings:test",
                layer: "warnings",
                category: "weather_warning",
                headline: "test",
                sourceId: "mock",
                observedAt: fetchedAt,
                confidence: 1,
                stale: false,
                severity: "info",
                urgency: "unknown",
                certainty: "unknown",
                license: { name: "test", attribution: "test" }
              }
            }
          ]
        };
      }
    };
    const service = new SafetyAggregationService(config, [source]);
    const query = {
      bbox: { west: 13.85, south: 49.65, east: 15.35, north: 50.45 },
      layers: ["warnings" as const],
      sourceIds: ["mock" as const],
      limit: 10,
      includeRaw: false
    };

    await Promise.all(Array.from({ length: 8 }, () => service.getFeatures(query)));

    expect(calls).toBe(1);
    expect(service.cacheStats().coalescedHits).toBe(7);
  });
});

async function withFixtureServer(
  routes: Record<string, string | { status: number; body: string }>,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer((req, res) => {
    const route = routes[req.url ?? ""];
    if (route === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    if (typeof route === "string") {
      res.writeHead(200, { "content-type": route.trim().startsWith("<") ? "application/xml" : "application/json" }).end(route);
      return;
    }
    res.writeHead(route.status).end(route.body);
  });
  await listen(server);
  try {
    const address = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await close(server);
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function chmiHydroMetadataFixture(): unknown {
  return {
    data: {
      data: {
        header: "objID,DBC,STATION_NAME,STREAM_NAME,GEOGR1,GEOGR2,SPA_TYP,DRYH,SPA1H,SPA2H,SPA3H,SPA4H",
        values: [
          ["0-203-1-good", "GOOD", "Good station", "Vltava", 50.05, 14.4, "H", 10, 100, 150, 200, 250],
          ["0-203-1-missing", "MISS", "Missing station", "Vltava", 50.06, 14.41, "H", 10, 100, 150, 200, 250]
        ]
      }
    }
  };
}

function chmiHydroNowFixture(stationId: string): unknown {
  return {
    objList: [
      {
        objID: stationId,
        tsList: [
          {
            tsConID: "H",
            unit: "CM",
            tsData: [{ dt: new Date().toISOString(), value: 42 }]
          }
        ]
      }
    ]
  };
}

function chmiNoWarningCapFixture(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>test-no-warning</identifier>
  <sender>chmi@chmi.cz</sender>
  <sent>2026-05-20T10:09:04+02:00</sent>
  <status>Actual</status>
  <msgType>Update</msgType>
  <scope>Public</scope>
  <info>
    <language>cs</language>
    <event>Žádná výstraha před teplotou</event>
    <urgency>Immediate</urgency>
    <severity>Minor</severity>
    <certainty>Unlikely</certainty>
    <onset>2026-05-20T10:03:21+02:00</onset>
    <description></description>
    <area><areaDesc>Hlavní město Praha</areaDesc></area>
  </info>
  <info>
    <language>en-GB</language>
    <event>Minor Temperature Warning</event>
    <urgency>Immediate</urgency>
    <severity>Minor</severity>
    <certainty>Unlikely</certainty>
    <onset>2026-05-20T10:03:21+02:00</onset>
    <description></description>
    <area><areaDesc>Hlavní město Praha</areaDesc></area>
  </info>
</alert>`;
}
