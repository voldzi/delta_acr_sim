import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { TakGatewayConfig } from "../src/config.js";

function config(overrides: Partial<TakGatewayConfig> = {}): TakGatewayConfig {
  return {
    port: 0,
    dataDir: "/tmp/tak-gateway-test",
    ingestToken: "secret",
    defaultBbox: { west: 13.5, south: 49.5, east: 15.5, north: 50.6 },
    staleAfterSeconds: 300,
    retentionSeconds: 3600,
    maxEvents: 100,
    exposeRaw: false,
    publicRead: true,
    sourceLabel: "TAK/CoT gateway",
    ...overrides
  };
}

function cotEvent(uid = "TAK-ARDOS-001"): string {
  const now = new Date();
  const stale = new Date(now.getTime() + 10 * 60_000);
  return `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0" uid="${uid}" type="a-f-G-U-C" time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}" how="m-g">
  <point lat="50.0870" lon="14.4210" hae="250" ce="15" le="20"/>
  <detail>
    <contact callsign="ARDOS Alpha"/>
    <__group name="ARDOS" role="Team Member"/>
    <track course="92" speed="4.2"/>
    <remarks>synthetic integration test</remarks>
  </detail>
</event>`;
}

describe("tak-gateway-api", () => {
  it("requires bearer token for CoT ingest", async () => {
    const { app } = await createApp(config());

    const response = await request(app).post("/api/v1/cot/events").set("content-type", "application/xml").send(cotEvent());

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("ingests CoT XML and exposes a COP GeoJSON projection", async () => {
    const { app } = await createApp(config());

    const ingest = await request(app)
      .post("/api/v1/cot/events")
      .set("authorization", "Bearer secret")
      .set("content-type", "application/xml")
      .send(cotEvent());

    expect(ingest.status).toBe(202);
    expect(ingest.body.eventCount).toBe(1);

    const events = await request(app).get("/api/v1/events");
    expect(events.status).toBe(200);
    expect(events.body.totalCount).toBe(1);
    expect(events.body.items[0].raw).toBeUndefined();

    const features = await request(app).get("/api/v1/cop/features?bbox=14,50,15,50.2&layers=mobile&limit=10");
    expect(features.status).toBe(200);
    expect(features.body.contractVersion).toBe("cop-tak-source-v1");
    expect(features.body.summary.featureCount).toBe(1);
    expect(features.body.features[0].geometry.coordinates).toEqual([14.421, 50.087]);
    expect(features.body.features[0].properties.label).toBe("ARDOS Alpha");
    expect(features.body.features[0].properties.affiliation).toBe("friend");
    expect(features.body.features[0].properties.raw).toBeUndefined();
  });

  it("rejects invalid CoT payloads", async () => {
    const { app } = await createApp(config());

    const response = await request(app)
      .post("/api/v1/cot/events")
      .set("authorization", "Bearer secret")
      .set("content-type", "application/xml")
      .send("<not-cot/>");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_COT_XML");
  });

  it("does not expose raw CoT unless explicitly enabled", async () => {
    const { app } = await createApp(config({ exposeRaw: true }));

    await request(app)
      .post("/api/v1/cot/events")
      .set("authorization", "Bearer secret")
      .set("content-type", "application/xml")
      .send(cotEvent("TAK-RAW-001"))
      .expect(202);

    const hidden = await request(app).get("/api/v1/cop/features?includeRaw=true");
    expect(hidden.body.features[0].properties.raw).toBeDefined();
  });

  it("accepts a payload with multiple adjacent CoT events", async () => {
    const { app } = await createApp(config());

    const response = await request(app)
      .post("/api/v1/cot/events")
      .set("authorization", "Bearer secret")
      .set("content-type", "application/xml")
      .send(`${cotEvent("TAK-BATCH-001")}\n${cotEvent("TAK-BATCH-002")}`);

    expect(response.status).toBe(202);
    expect(response.body.eventCount).toBe(2);

    const features = await request(app).get("/api/v1/cop/features?layers=mobile&limit=10");
    expect(features.body.summary.featureCount).toBe(2);
  });

  it("can protect feature reads with a separate read token", async () => {
    const { app } = await createApp(config({ publicRead: false, readToken: "read-secret" }));

    await request(app)
      .post("/api/v1/cot/events")
      .set("authorization", "Bearer secret")
      .set("content-type", "application/xml")
      .send(cotEvent("TAK-PROTECTED-001"))
      .expect(202);

    await request(app).get("/api/v1/cop/features").expect(401);

    const response = await request(app).get("/api/v1/cop/features").set("authorization", "Bearer read-secret");
    expect(response.status).toBe(200);
    expect(response.body.summary.featureCount).toBe(1);
  });
});
