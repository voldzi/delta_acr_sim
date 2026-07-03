# ADR-0015: COP Sensor Node and TAK Flight Bridge

## Status
Accepted

## Context

COP needs richer air-situation inputs than public ADS-B alone: project-owned
ADS-B receivers, Remote ID receivers, future passive sensor kits and eventually
a private TAK server. At the same time COP should remain a presentation layer
that reads normalized SIM provider contracts instead of parsing each edge or TAK
payload directly.

Remote ID and local sensor data can include regulated or personal information.
The integration therefore needs a strict server-to-server boundary, provenance,
token authentication and a reduced COP-facing output.

## Decision

SIM will terminate COP Sensor Node batches in `flight-data-api` through
`POST /api/v1/ingest/sensor-observations`.

ADS-B and Remote ID observations are normalized into the existing
`partner_air_tracks` source so COP continues to read
`GET /api/v1/cop/tracks`. Weather and health observations are retained only as
sensor-node diagnostics. Remote ID raw identifiers are hashed when needed, and
operator or pilot location fields are not propagated to the standard COP flight
track output.

SIM will expose a protected outbound CoT export for normalized flight tracks at
`GET /api/v1/cot/tracks`. TAK inbound remains owned by `tak-gateway-api` through
`POST /tak-gateway/api/v1/cot/events`.

Flight tracks will include structured `quality.measurement` fields for COP
prediction and rendering, including prediction support level, ADS-B quality
codes, receiver IDs, signal counts and accuracy estimates where upstream data is
available.

## Consequences

COP gets one stable air-track contract regardless of whether the source is
ADSB.lol, local readsb, partner ingest or COP Sensor Node. COP can improve
prediction confidence without reading raw upstream payloads.

Sensor-node tokens, partner ingest tokens and TAK export tokens stay server-side
and must not be embedded in COP frontend bundles.

The future private TAK server can ingest SIM-normalized CoT output without
changing the COP map provider. The CoT bridge is for situational awareness only;
it must not be used for targeting, weapon workflow or tactical guidance.

## Alternatives Considered

- Build COP Sensor Node as a separate production service now. Rejected because
  the current need is server-side ingest and normalization; hardware firmware and
  fleet management can evolve independently.
- Let COP call sensor nodes directly. Rejected because it would expose tokens,
  duplicate parsing and weaken privacy controls.
- Store all raw Remote ID data in standard flight tracks. Rejected because raw
  identifiers and operator location are not appropriate for the default COP
  flight layer.

## Follow-up Actions

- Add persistent sensor-node registry if fleet management needs survive service
  restarts.
- Add hardware attestation/signature verification before accepting field-deployed
  public sensor fleets.
- Connect the outbound CoT export to the future private TAK server when that
  deployment exists.
