# Internal geo-routing-v1 contract

**Status:** implemented; internal server-to-server API

## Ownership and topology

The SIM application owner operates this contract, `situation-data-api`, and the
owned Valhalla service on `valhalla.home.cz`. The only supported topology is:

```text
public client -> consumer backend -> authenticated SIM geo-routing-v1 -> Valhalla
```

The browser receives the stored route snapshot from its own backend. It never
receives a SIM/Valhalla URL or service token and never calls SIM or Valhalla
directly. Requests carrying an `Origin` header are rejected with 403 as an
additional application-level control. The provider gateway and DMZ controls in
[12_PROVIDER_ACCESS_CONTROL.md](../runbooks/12_PROVIDER_ACCESS_CONTROL.md)
remain mandatory.

## Operation

Internal service URL:

```text
POST http://docker.home.cz:5020/situation-data/api/v1/geo-routing-v1/route
```

Container-local path:

```text
POST /api/v1/geo-routing-v1/route
```

The binding fragment is
[`openapi/fragments/geo-routing-v1.openapi.json`](../../openapi/fragments/geo-routing-v1.openapi.json)
and is merged into [`openapi/openapi.json`](../../openapi/openapi.json).

Authentication uses an opaque bearer token assigned to one backend identity in
`GEO_ROUTING_SERVICE_TOKENS` as comma-separated `actor:token` entries. The
declared audience is `csm-sim-geo-routing-v1` and the only v1 scope is
`geo-routing:route`. Tokens are never returned or logged. Each consuming
backend receives a distinct actor/token entry.

## Request rules

```json
{
  "contractVersion": "geo-routing-v1",
  "profile": "bicycle",
  "locations": [
    { "longitude": 17.3291, "latitude": 50.1198 },
    { "longitude": 17.3358, "latitude": 50.1135 },
    { "longitude": 17.3472, "latitude": 50.1081 }
  ],
  "options": {
    "elevation": true,
    "optimizeWaypointOrder": false
  }
}
```

- Profiles: `walking`, `bicycle`.
- Coordinates are explicit WGS84 longitude/latitude values.
- All locations are sent to Valhalla `/route` as ordered `break` locations.
  SIM never calls Valhalla `/optimized_route` for this contract.
- `optimizeWaypointOrder=true` is rejected with
  `WAYPOINT_OPTIMIZATION_NOT_SUPPORTED`.
- Elevation is always enabled in v1; `elevation=false` is rejected.
- Unknown request/options/location fields are rejected.
- A fallback or incomplete geometry is an error, never a successful response.

## Limits

| Limit | Production value |
| --- | ---: |
| JSON body | 1 MiB |
| Waypoints | 2–25 |
| Sum of ordered straight-line legs | 1,000,000 m |
| Valhalla dependency timeout | 8,000 ms |
| Rate limit | 60 requests/minute/service identity |
| `Idempotency-Key` | 1–128 safe ASCII characters |
| Snap distance at every waypoint | 2,500 m maximum |

Rate responses include `Retry-After` and `X-RateLimit-*`. The values are
configurable without changing the API contract.

## Successful response

```json
{
  "contractVersion": "geo-routing-v1",
  "profile": "bicycle",
  "waypointOrder": [0, 1, 2],
  "geometry": {
    "type": "LineString",
    "coordinates": [[17.3291, 50.1198], [17.331, 50.117], [17.3472, 50.1081]]
  },
  "summary": {
    "distanceM": 2380,
    "durationSeconds": 710,
    "elevationGainM": 84,
    "elevationLossM": 41
  },
  "routingDataset": {
    "version": "sim-routing-2026-07-19-1784432066",
    "builtAt": "2026-07-19T03:34:26.000Z"
  },
  "computedAt": "2026-08-10T12:00:00.000Z"
}
```

`waypointOrder` is always `[0, 1, ... n-1]`. The dataset values come from the
live Valhalla `tileset_last_modified`, not the running application version.
`GET /situation-data/health/ready` exposes the same dataset metadata with
Valhalla dependency state.

## Publication-time idempotency

A publishing backend sends its stable publication attempt key in
`Idempotency-Key`. SIM stores only the normalized request hash, consumer actor,
and complete technical route response under the SIM data volume. It does not
store a story, game, editor, player, or other consumer-domain record.

- first request: compute, persist atomically, return 200 and
  `X-Idempotent-Replay: false`;
- identical actor/key/request: return the original snapshot and
  `X-Idempotent-Replay: true` without calling Valhalla;
- same actor/key with a different normalized request: return 409
  `IDEMPOTENCY_CONFLICT`;
- keys are namespaced by service identity.

The consumer backend stores the returned snapshot with its published content
and serves it until explicit republication. A later Valhalla update therefore
does not silently change published content.

## Errors and observability

Errors use the SIM envelope with `error.code`, `error.message` and
`error.correlationId`. `X-Correlation-Id` is preserved by HTTP tracing. Route
bodies, service tokens, and precise locations are not written to application
logs. The readiness endpoint checks Valhalla `/status`; production monitoring
must alert when Valhalla is degraded or dataset metadata is absent/stale.

## Acceptance evidence

`apps/situation-data-api/test/contract.test.ts` covers all handoff cases:
two-point walking, two- and four-point bicycle, exact order, GeoJSON and
non-negative values, dataset metadata, invalid inputs/optimization rejection,
Valhalla degradation, authenticated backend/browser rejection, and idempotent
publication retry without consumer-domain storage.

## Rollback

1. Remove `GEO_ROUTING_SERVICE_TOKENS` (endpoint becomes unauthorized) or block
   the path at the internal gateway for immediate containment.
2. Roll back the SIM image/commit and recreate only `situation-data-api`.
3. Leave `/data/geo-routing-v1/precomputed` intact for audit/retry, or archive
   it before deletion; it is not required by older SIM images.
4. Do not roll back Valhalla unless its independent health/canary checks fail.
   Valhalla rollback follows
   [15_VALHALLA_PRODUCTION.md](../runbooks/15_VALHALLA_PRODUCTION.md).
