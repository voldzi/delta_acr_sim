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

- Situation map queries: protected by canonical bbox cache and source-level
  caches.
- CHMI weather radar frame lookup: protected by a small index cache.
- CHMI clean radar PNG generation: CPU and I/O heavy on first request for a
  frame; protected by local file cache and in-flight deduplication.
- PostGIS-backed OSM/mobile read models: should stay on Patroni/PostGIS and
  avoid public Overpass in production runtime.

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
4. Crops the PNG to radar data bounds.
5. Stores the clean PNG under the radar frame cache directory.
6. Returns the clean PNG with cacheable HTTP headers.

This means thousands of COP browser sessions should not trigger thousands of
CHMI upstream requests or thousands of duplicate PNG crops for the same frame.

## Production Settings

Recommended defaults:

```bash
SITUATION_DATA_CACHE_MAX_ENTRIES=10000
SITUATION_DATA_STALE_IF_ERROR_SECONDS=1800
SITUATION_DATA_CHMI_WEATHER_RADAR_CACHE_TTL_SECONDS=300
SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_HISTORY_HOURS=6
SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_MAX_COUNT=72
SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_STORE_ENABLED=false
SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_STORE_DIR=/data/weather-radar-frames
SITUATION_DATA_CHMI_WEATHER_RADAR_CLEAN_CROP_INSET_PIXELS=2
```

`FRAME_STORE_ENABLED=false` is acceptable because clean frames still materialize
lazy on first request. Enable it only when COP deliberately prewarms recent
frames.

## Operational Checks

After deploy:

```bash
curl -fsS http://127.0.0.1:5020/health/live
curl -fsS http://127.0.0.1:5020/situation-data/health/ready
curl -fsS 'http://127.0.0.1:5020/situation-data/api/v1/weather-radar/frames?product=merge1h&hours=1&limit=1'
```

Then request the returned `cleanUrl` once and repeat it. The first request may
take longer while SIM fetches and crops the PNG; the second should be served
from the local frame cache.

## Remaining Optimizations

- Add a dedicated background radar prewarmer if COP needs instant playback
  startup for the latest N frames.
- Add an nginx or CDN cache in front of clean frame URLs if SIM is exposed to a
  high number of simultaneous COP browser clients through the COP backend.
- Add native tiled radar output if browser-side large overlay images become a
  bottleneck at high zoom.
