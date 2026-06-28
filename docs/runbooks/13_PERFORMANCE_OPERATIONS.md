# Performance Operations

## Scope

This runbook records the current performance review focus for CSM SIM. SIM is a
server-to-server provider, so the main performance goal is to avoid repeated
upstream calls and repeated expensive local work when COP has many users.

## Repository And Build Footprint

The repository has no tracked large binary assets above the normal application
size. Local `node_modules` is the dominant workspace size and must not be part
of deployment artifacts. Runtime radar and DEM data belong in Docker volumes or
external storage, not in Git.

## Primary Hot Paths

- SIM Overview first load: protected by `GET /api/v1/operations/summary`, which
  probes provider health/observability only and does not request full map
  feature preview payloads.
- Flight map queries: protected by canonical padded bbox cache. The cached
  upstream fetch uses a stable envelope, while the returned track list is
  filtered back to the requested viewport.
- Situation map queries: protected by canonical bbox cache and source-level
  caches.
- CHMI weather radar frame lookup: protected by a small index cache.
- CHMI clean radar PNG generation: CPU and I/O heavy on first request for a
  frame; protected by local file cache and in-flight deduplication.
- PostGIS-backed OSM/mobile read models: should stay on Patroni/PostGIS and
  avoid public Overpass in production runtime.
- DEM/radio-planning requests: protected by normalized per-operation cache for
  `link-check`, `coverage` and `site-search`, so repeated COP detail actions do
  not rerun the same terrain sampling loop.

## Radar Performance Model

For PNG radar products, SIM now exposes:

```http
GET /api/v1/weather-radar/frames
GET /api/v1/weather-radar/clean/{productId}/{fileName}
```

The clean endpoint:

1. Checks local clean frame cache.
2. Coalesces concurrent requests for the same frame through one in-flight
   materialization Promise.
3. Reads locally stored raw frame when available, otherwise fetches the raw CHMI
   PNG once.
4. Detects the actual CHMI radar data frame, crops the PNG to that data area,
   and removes neutral gray/black source-frame pixels by making them
   transparent.
5. Stores the clean PNG under the radar frame cache directory.
6. Returns the clean PNG with cacheable HTTP headers.

This means thousands of COP browser sessions should not trigger thousands of
CHMI upstream requests or thousands of duplicate PNG crops for the same frame.

## Production Settings

Recommended defaults:

```bash
FLIGHT_DATA_BBOX_CACHE_GRID_DEGREES=0.1
FLIGHT_DATA_BBOX_CACHE_PADDING_DEGREES=0.08
SITUATION_DATA_CACHE_MAX_ENTRIES=10000
SITUATION_DATA_STALE_IF_ERROR_SECONDS=1800
SITUATION_DATA_CHMI_WEATHER_RADAR_CACHE_TTL_SECONDS=300
SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_HISTORY_HOURS=6
SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_MAX_COUNT=72
SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_STORE_ENABLED=false
SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_STORE_DIR=/data/weather-radar-frames
SITUATION_DATA_CHMI_WEATHER_RADAR_CLEAN_CROP_INSET_PIXELS=2
SITUATION_DATA_RADIO_PLANNING_CACHE_TTL_SECONDS=900
SITUATION_DATA_RADIO_PLANNING_CACHE_MAX_ENTRIES=512
```

`FRAME_STORE_ENABLED=false` is acceptable because clean frames still materialize
lazy on first request. Enable it only when COP deliberately prewarms recent
frames.

## Operational Checks

After deploy:

```bash
curl -fsS http://127.0.0.1:5020/health/live
curl -fsS http://127.0.0.1:5020/api/v1/operations/summary
curl -fsS http://127.0.0.1:5020/situation-data/health/ready
curl -fsS http://127.0.0.1:5020/situation-data/api/v1/observability
python3 scripts/smoke-provider-gateway.py --base-url http://127.0.0.1:5020
curl -fsS 'http://127.0.0.1:5020/situation-data/api/v1/weather-radar/frames?product=merge1h&hours=1&limit=1'
```

Then request the returned `cleanUrl` once and repeat it. The first request may
take longer while SIM fetches and crops the PNG; the second should be served
from the local frame cache.

`scripts/smoke-provider-gateway.py` checks the provider contract consumed by
COP: gateway health, internal-only access-control, taxonomy dictionaries,
lightweight feature summaries, density grid cells, detail links, separate
geometry documents and repeated radio `link-check` cache telemetry.

## Gateway Stale Cache

`sim-web` has a short nginx cache for internal GET provider API routes:
`/flight-data/api/*`, `/situation-data/api/*` and `/safety-data/api/*`. It keeps
successful `200` responses valid for 10 seconds and may serve them stale on
backend errors during deploy. This is intended to protect COP polling loops from
brief `502` windows while a single backend container is recreated.

Use `?nocache=1` or an `Authorization` header when diagnosing an endpoint and
the gateway cache must be bypassed. The response header `X-SIM-Gateway-Cache`
shows nginx cache status such as `MISS`, `HIT`, `STALE` or `UPDATING`.
Gateway responses on these routes use `Cache-Control: private, max-age=10`
regardless of longer upstream provider cache headers.

## Radio Planning Cache

Radio planning cache state is exposed through:

```http
GET /situation-data/api/v1/observability
GET /situation-data/metrics
```

The Prometheus metric prefix is
`situation_data_radio_planning_cache_*{operation="link_check|coverage|site_search"}`.
Low hit rate is normal immediately after deploy; sustained zero hits while COP
operators repeatedly open the same radio detail usually means COP is changing
request parameters between refreshes.

## Remaining Optimizations

- Add a dedicated background radar prewarmer if COP needs instant playback
  startup for the latest N frames.
- Add an nginx or CDN cache in front of clean frame URLs if SIM is exposed to a
  high number of simultaneous COP browser clients through the COP backend.
- Add native tiled radar output if browser-side large overlay images become a
  bottleneck at high zoom.
