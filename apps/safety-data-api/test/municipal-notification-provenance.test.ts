import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig, type MunicipalAlertFeedConfig, type SafetyDataConfig } from "../src/config.js";

const NOW = "2026-10-10T12:00:00.000Z";
const START = "2026-10-10T11:50:00.000Z";
const END = "2026-10-10T12:20:00.000Z";
const PKR_INTERVAL = "vznik: 10. 10. 2026, 13:50, ukončení: 10. 10. 2026, 14:20";

describe("Municipal notification provenance through the actual mapper", () => {
  let dataDir: string;
  let baseConfig: SafetyDataConfig;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    dataDir = await mkdtemp(join(tmpdir(), "csm-municipal-notification-provenance-"));
    vi.stubEnv("SAFETY_DATA_DIR", dataDir);
    vi.stubEnv("SAFETY_DATA_ENABLED_SOURCES", "municipal_alerts");
    vi.stubEnv("SAFETY_DATA_ADMIN_BOUNDARY_DATABASE_URL", "");
    vi.stubEnv("OSM_POSTGIS_DATABASE_URL", "");
    vi.stubEnv("MEDIA_NEWS_ENABLED", "false");
    baseConfig = await loadConfig();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("keeps a geolocated RSS publication informational even with an explicit feed expiry", async () => {
    const app = await withFeed(
      "rss",
      `<?xml version="1.0"?><rss version="2.0" xmlns:georss="http://www.georss.org/georss"><channel><item><title>Výstraha: evakuace domu v Mostě</title><description>Řiďte se oficiálními pokyny.</description><guid>rss-1</guid><pubDate>Sat, 10 Oct 2026 11:50:00 GMT</pubDate><expires>${END}</expires><georss:point>50.49 13.65</georss:point></item></channel></rss>`
    );
    const map = await request(app).get("/api/v1/features?layers=warnings&source=municipal_alerts&limit=10").expect(200);
    const result = await notifications(app);

    expect(map.body.features).toHaveLength(1);
    expect(map.body.features[0].properties).toMatchObject({
      tags: { locationPrecision: "source_point" },
      providerProperties: {
        publication: { publishedAt: START, eventAt: null, eventValidUntil: null },
        notification: { eligible: false, informationalOnly: true, validityBasis: "publication_or_snapshot_only" }
      }
    });
    expect(result.body.inputReadiness.status).toBe("ready");
    expect(result.body.candidates).toEqual([]);
    expect(result.body.summary.eligibilitySkippedReasons).toEqual({ informational_only: 1 });
  });

  it("produces a candidate only for verified PKR geometry and a real parsed current event interval", async () => {
    const app = await withFeed("pkr-json", pkrJson(PKR_INTERVAL));
    const map = await request(app).get("/api/v1/features?layers=warnings&source=municipal_alerts&limit=10").expect(200);
    const result = await notifications(app);

    expect(map.body.features[0].properties).toMatchObject({
      validFrom: START,
      validUntil: END,
      tags: { locationPrecision: "source_pkr_json" },
      providerProperties: {
        publication: { eventAt: START, eventValidUntil: END },
        notification: { eligible: true, informationalOnly: false, validityBasis: "explicit_event_interval" }
      }
    });
    expect(map.body.features[0].geometry.coordinates).toEqual([13.652638, 50.493539]);
    expect(result.body.inputReadiness.status).toBe("ready");
    expect(result.body.candidates).toHaveLength(1);
    expect(result.body.candidates[0].feature).toMatchObject({ validFrom: START, validUntil: END, sourceId: "municipal_alerts" });
    expect(JSON.stringify(result.body.candidates)).not.toContain('"raw"');
  });

  it.each([undefined, "vznik: 10. 10. 2026, 13:50", "ukončení: 10. 10. 2026, 14:20", "vznik: 10. 10. 2026, 14:40, ukončení: 10. 10. 2026, 14:20"])(
    "does not treat synthetic or unordered PKR validity as an actual event interval: %s",
    async (description) => {
      const app = await withFeed("pkr-json", pkrJson(description));
      const map = await request(app).get("/api/v1/features?layers=warnings&source=municipal_alerts&limit=10").expect(200);
      const result = await notifications(app);

      expect(map.body.features).toHaveLength(1);
      expect(map.body.features[0].properties.providerProperties.notification).toMatchObject({
        eligible: false,
        informationalOnly: true,
        validityBasis: "publication_or_snapshot_only"
      });
      expect(result.body.candidates).toEqual([]);
    }
  );

  it("does not use the authority fallback point even when PKR event timing is explicit", async () => {
    const app = await withFeed("pkr-json", pkrJson(PKR_INTERVAL, false));
    const map = await request(app).get("/api/v1/features?layers=warnings&source=municipal_alerts&limit=10").expect(200);
    const result = await notifications(app);

    expect(map.body.features[0]).toMatchObject({
      geometry: { type: "Point", coordinates: [13.82, 50.52] },
      properties: {
        tags: { locationPrecision: "authority_fallback_point" },
        providerProperties: { notification: { eligible: false, informationalOnly: true } }
      }
    });
    expect(result.body.candidates).toEqual([]);
  });

  it("never revives a municipal event after its interval expires in an otherwise fresh aggregate", async () => {
    const app = await withFeed("pkr-json", pkrJson(PKR_INTERVAL));
    const first = await notifications(app);
    expect(first.body.candidates).toHaveLength(1);

    vi.setSystemTime(new Date("2026-10-10T12:20:00.000Z"));
    const expired = await notifications(app);

    expect(expired.body.candidates).toEqual([]);
    expect(expired.body.inputReadiness.status).toBe("ready");
    expect(expired.body.summary.eligibilitySkippedReasons).toEqual({ inactive_municipal_alert: 1 });
  });

  async function withFeed(format: MunicipalAlertFeedConfig["format"], body: string) {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(body, { headers: { "content-type": format === "pkr-json" ? "application/json" : "application/rss+xml" } })
    );
    vi.stubGlobal("fetch", fetcher);
    const feed: MunicipalAlertFeedConfig = {
      id: "verified-contract-fixture",
      url: "https://municipal.example.test/feed",
      label: "Municipal fixture",
      authorityName: "Ústecký kraj",
      fallbackLon: 13.82,
      fallbackLat: 50.52,
      bbox: { west: 12.8, south: 50.05, east: 14.7, north: 51.1 },
      format
    };
    return (await createApp({ ...baseConfig, municipalAlertFeeds: [feed] })).app;
  }
});

function notifications(app: Awaited<ReturnType<typeof createApp>>["app"]) {
  return request(app).get("/api/v1/notifications/candidates?layers=warnings&source=municipal_alerts&limit=10").expect(200);
}

function pkrJson(description?: string, includeGeometry = true): string {
  return JSON.stringify({
    result_items: [
      {
        ret: [
          {
            id: 11960,
            uuid: "contract_pkr_11960",
            ...(includeGeometry ? { geom: { lon: "-790641.0", lat: "-990557.0" } } : {}),
            name: "Požár - Most",
            label_title: "Požár - Most",
            label_description: description,
            popup_url: "11960/?fmt=popup",
            url_prefix: "/pkr/zasahy/"
          }
        ]
      }
    ]
  });
}
