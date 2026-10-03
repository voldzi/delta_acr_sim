// Read-only, per-request synthetic exclusions. No graph/traffic/global closure writes.
// Run after pnpm build. This is compatibility evidence, NOT closure/vehicle acceptance.
import assert from "node:assert/strict";
import { decodeValhallaPolyline6 } from "../apps/situation-data-api/dist/routing-service.js";
import { verifyClosureGeometry } from "../apps/situation-data-api/dist/routing-safety.js";
const url = process.argv[2];
if (!url || new URL(url).hostname !== "valhalla.home.cz" || new URL(url).port !== "8002") throw Error("Explicit internal Valhalla URL required");
async function call(path, payload) {
  const r = await fetch(new URL(path, url), {
    method: payload ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data = await r.json();
  return { status: r.status, data };
}
const status = await call("/status");
assert.equal(status.status, 200);
assert.equal(status.data.version, "3.8.3");
console.log(JSON.stringify({ check: "engine", version: status.data.version, tileset: status.data.tileset_last_modified }));
const initial = await call("/route", {
  locations: [
    { lat: 50.0675, lon: 14.425, radius: 500, search_cutoff: 500 },
    { lat: 50.04, lon: 14.48, radius: 500, search_cutoff: 500 }
  ],
  costing: "auto",
  units: "kilometers"
});
assert.equal(initial.status, 200);
const shape = decodeValhallaPolyline6(initial.data.trip?.legs?.[0]?.shape);
assert.ok(shape.length > 15);
const first = shape[0],
  last = shape.at(-1),
  middle = shape[Math.floor(shape.length / 2)];
const polygon = [
  [middle[0] - 0.00004, middle[1] - 0.00004],
  [middle[0] + 0.00004, middle[1] - 0.00004],
  [middle[0] + 0.00004, middle[1] + 0.00004],
  [middle[0] - 0.00004, middle[1] + 0.00004],
  [middle[0] - 0.00004, middle[1] - 0.00004]
];
const now = Date.now(),
  date = (t) => new Date(t).toISOString();
const snapshot = {
  version: "sim-reviewed-road-closures-v1",
  revision: "SYNTHETIC-PER-REQUEST-ONLY",
  observedAt: date(now),
  validUntil: date(now + 600000),
  coverage: "authoritative_reviewed_snapshot",
  routingDataset: { version: "compatibility-only", builtAt: date(status.data.tileset_last_modified * 1000) },
  bbox: { west: 10, south: 45, east: 20, north: 55 },
  closures: [
    {
      id: "SYNTHETIC-NOT-A-REAL-CLOSURE",
      status: "active",
      direction: "both",
      validFrom: date(now - 1000),
      validUntil: date(now + 600000),
      polygon,
      source: { authority: "synthetic-test", reference: "not-a-real-closure", reviewedAt: date(now) }
    }
  ]
};
let crossed = false;
try {
  verifyClosureGeometry(shape, snapshot, now);
} catch {
  crossed = true;
}
assert.ok(crossed, "Synthetic polygon must intersect baseline");
const locations = (reverse = false) =>
  [...(reverse ? [last, middle, first] : [first, middle, last])].map((p, i) => ({
    lon: p[0],
    lat: p[1],
    type: i === 1 ? "break_through" : "break",
    radius: 25,
    search_cutoff: 25
  }));
const options = (costing) => ({
  [costing]: {
    height: 1.8,
    width: 1.9,
    length: 4.5,
    weight: 1.9,
    ignore_restrictions: false,
    ignore_oneways: false,
    ignore_access: false,
    ignore_closures: false,
    ignore_non_vehicular_restrictions: false,
    exclude_unpaved: true,
    use_tolls: 0,
    speed_types: ["freeflow", "constrained", "predicted"],
    ...(costing === "truck" ? { hgv_no_access_penalty: 43200 } : {})
  }
});
for (const costing of ["auto", "truck"]) {
  const r = await call("/route", {
    locations: locations(),
    costing,
    costing_options: options(costing),
    date_time: { type: 0 },
    alternates: 1,
    units: "kilometers"
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.trip.legs.length, 2);
  assert.ok(!(r.data.warnings ?? []).some((w) => w.code === 500), "Engine must not clamp supplied restrictions");
  console.log(
    JSON.stringify({
      check: "ordinary-intent-payload-and-via",
      costing,
      status: r.status,
      legs: r.data.trip.legs.length,
      variants: 1 + (r.data.alternates?.length ?? 0)
    })
  );
}
for (const reverse of [false, true]) {
  // Omit via inside the deliberately excluded polygon: otherwise no route is expected.
  const loc = locations(reverse).filter((_p, i) => i !== 1);
  const r = await call("/route", {
    locations: loc,
    costing: "auto",
    costing_options: options("auto"),
    date_time: { type: 0 },
    exclude_polygons: [polygon],
    alternates: 2,
    units: "kilometers"
  });
  if (r.status !== 200) {
    assert.equal(r.status, 400);
    assert.equal(r.data.error_code, 171, "Only a confirmed no-route error is acceptable");
    console.log(JSON.stringify({ check: "synthetic-both-direction-exclusion", reverse, result: "no_route", status: r.status }));
    continue;
  }
  const trips = [r.data.trip, ...(r.data.alternates ?? []).map((a) => a.trip)];
  for (const trip of trips) for (const leg of trip.legs) verifyClosureGeometry(decodeValhallaPolyline6(leg.shape), snapshot, now);
  console.log(JSON.stringify({ check: "synthetic-both-direction-exclusion", reverse, result: "all_variants_outside_polygon", variants: trips.length }));
}
const after = await call("/status");
assert.equal(after.data.tileset_last_modified, status.data.tileset_last_modified);
console.log(
  JSON.stringify({
    compatibility: "passed",
    syntheticOnly: true,
    graphUnchanged: true,
    authoritativeClosureAcceptance: false,
    mappedVehicleLimitAcceptance: false
  })
);
