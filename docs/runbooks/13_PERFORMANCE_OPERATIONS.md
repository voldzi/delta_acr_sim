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
SITUATION_DATA_WEATHER_RADAR_CACHE_HOST_DIR=/srv/x5-production/cache/csm-sim/weather-radar-frames
SITUATION_DATA_CHMI_WEATHER_RADAR_CLEAN_CROP_INSET_PIXELS=2
SITUATION_DATA_RADIO_PLANNING_CACHE_TTL_SECONDS=900
SITUATION_DATA_RADIO_PLANNING_CACHE_MAX_ENTRIES=512
```

`FRAME_STORE_ENABLED=false` is acceptable because clean frames still materialize
lazy on first request. Enable it only when COP deliberately prewarms recent
frames.

## X5 write-cache layout

Production keeps only reproducible, write-heavy artifacts on the unbacked X5
filesystem:

- `/srv/x5-production/cache/csm-sim/copernicus-glo30` — DEM cache;
- `/srv/x5-production/cache/csm-sim/nginx-provider` — provider response cache;
- `/srv/x5-production/cache/csm-sim/operational-checks` — derived check log;
- `/srv/x5-production/cache/csm-sim/valhalla-traffic` — normalized traffic cache;
- `/srv/x5-production/cache/csm-sim/weather-radar-frames` — derived radar frames;
- `/srv/x5-production/cache/csm-sim/osm-import` — downloadable PBF and import work.

Every X5 bind requires filesystem UUID
`2f93f595-b61b-4eea-9054-7afa9b275b5b` and has automatic host-path creation
disabled. Keep the previous internal copy for at least seven days after a
migration and remove it only with separate approval.

Persistent application files use the backup-required data tree:

- `/srv/x5-production/data/csm-sim/sim-data` — SIM audit, queue and store;
- `/srv/x5-production/data/csm-sim/situation-data` — geo-routing artifacts;
- `/srv/x5-production/data/csm-sim/safety-data` — CHMI hydrology history.

These directories are not disposable caches. Infrastructure backup and a
tested restore are required, especially for `safety-data`, whose upstream
history cannot be completely backfilled. PostgreSQL remains in Patroni behind
HAProxy; Valkey persistence, secrets, deployment configuration and source code
must never use X5.

## Operational Checks

### Search partial-feed recovery

Complete feeds retain configured TTL (production 300s); source-incomplete feeds
use at most 30s without stale-on-error extension. Safety bridge includes body
in `min(SITUATION_DATA_REQUEST_TIMEOUT_MS, 4500)`, below COP's 6s deadline.
Safety can finish its existing coalesced snapshot load after disconnection;
provider cadence and notification readiness remain unchanged. This is not a
total deadline guarantee for the other search providers.

Verify ordinary internal COP `/entities?limit=1000`: retain only status, latency,
`generatedAt`, summary, warning markers, cursor presence and `X-SIM-Gateway-Cache`.
Do not output entities/GPS/raw errors; observe normal expiry, not cachebusting.
Older observations can legitimately keep quality degraded after recovery.

Deploy only SDA from the exact deployed routing revision plus this patch.
Keep the rollback image, environment/mount/network hashes and other container IDs.
Do not rebuild SDA from an older crisis-only branch lacking routing/closure guards.
Verify health, a synthetic car route and graph-bound closures. Rollback selects
the previous image in the existing Compose override and recreates only SDA with
`--no-deps --no-build`; no migration, network or secret change is involved.

### Search read time freshness acceptance

[ADR 0037](../adr/0037_SEARCH_FEED_READ_TIME_FRESHNESS.md) is prepared source;
its production rollout remains blocked until the coordinated build/deploy
window and joint SIM/COP acceptance. Prepare the selected search diff against
the recorded deployed routing source `03b842e`, not an older crisis-source
branch. Preflight must reverify the actual running image and source revision;
an older observation is not authority to replace a newer release.

Observe the ordinary COP processing path without new diagnostic domain queries,
cachebusting, provider refreshes, wider limits or relaxed health gates. Capture
only a bounded allowlist in existing structured logs under their existing
retention: HTTP status and latency, static reason/source codes, feed
`generatedAt`, returned/collection summary counts with explicit scope,
`freshness` enum/ISO/count fields when present, cursor presence (never value),
gateway cache state and recognized numeric cache counters. The existing
observability contract may also supply service `status`, optional
`dataQualityStatus`/`degradedSourceCount`, source quality/stale counts and source
`lastSuccessAt`. Do not introduce a diagnostic database, durable snapshot store
or a purely cache-only endpoint for this repair.

Keep absent metadata unknown. In particular, a missing `freshness` object,
optional quality or source success time must not become `ok`, zero or the
current request time. Feed age is not observation age; for a future or invalid
feed time its value is `null`. `freshness.scope=returned_entities` counts only
the current page, while `/entities` legacy `summary.staleEntityCount` retains
the collected snapshot scope. Source observability counters have their own
source snapshot scope. A complete cached collection and an entirely fresh
returned page are different claims.

An nginx `HIT` or `STALE` can return previously serialized freshness without
executing the application projection again. Preserve and inspect its original
`evaluatedAt`; do not claim it was recomputed at the consumer request time.
The gateway policy is unchanged. This is why the consumer must still enforce
entity validity rather than trust a cached freshness count alone.

Missing-expiry counts include normalized values without both deadlines and can
include provider values normalized to null. Invalid-expiry counts cover only
invalid fields still present in returned normalized entities; zero cannot
certify that all raw source timestamps were valid. OSM reference entities
without expiry do not become a source outage or a live observation. Safety
`lastSuccessAt` must be its actual `lastResult.generatedAt`, not observability
response time. Preserve original entity observation, validity and revisions.

Post-build checks must cover the expiry transition on an application-cache hit,
query stale filtering, unchanged partial/full TTL, Safety staleness/snapshot
time and additive OpenAPI compatibility. Deploy only Situation Data API and
preserve routing/closure guards, pilot flags, HMAC/service tokens, database
configuration, mounts, internal network membership and all other containers.
Record the exact candidate and rollback image identities before activation.
Rollback reselects the prior image through the same existing Compose overlays
and recreates only Situation Data API; no data migration is required.

If a gate fails, retain only the allowed metadata from that failed processing
step before rollback. Do not log entities, IDs, GPS/geometry, query text, raw
warnings, provider URLs, cursors, request bodies or secret values. A subsequent
green healthcheck cannot reconstruct a missing earlier snapshot. The prior
historical failure has no established provider, PostgreSQL or API cause; this
repair addresses proven freshness/diagnostic gaps without asserting one.

### Pinned search freshness deployment

This release uses `scripts/deploy-search-freshness.mjs`, not the historical
`deploy-routing-unroutable.mjs` or the full-stack `deploy-docker-home.sh`.
The historical routing guard remains unchanged. The new guard is restricted
to the following source and image identities:

| Identity | Exact value |
| --- | --- |
| Source revision | `90e1d8d0cc50236429b32476e3fd2f31899cf03c` |
| Runtime base revision | `03b842e005f103bb02d622bb4fc95f27fbea9572` |
| Existing image pin | `sim-situation-data-api:routing-location-03b842e005f1` |
| Existing image ID | `sha256:2f3aa1659d03c5eaf014353071e38f6abc1d2da1419a9ac2205a05b5873a5965` |
| Candidate image pin | `sim-situation-data-api:search-freshness-90e1d8d0cc50` |
| Protected rollback alias | `sim-situation-data-api:rollback-search90-03b842e005f1` |
| Search source SHA-256 | `698e3dd4d978db08cd8ddbc484082327b3743392913ad37b53244cab3a327aaa` |
| Search compiled SHA-256 | `3060a86a481496e701f9f3c1523bb2c95f68825348a285fe7979a090fe4aad1b` |

Both image pin values are exactly 52 ASCII bytes. The source revision is not
the later operations commit containing this guard and runbook. Review and
record that operations commit and the guard file SHA-256 separately; never
substitute a moving branch, `HEAD`, an old workspace or `/srv/sim`'s unrelated
checkout for the source revision above.

Run local guard tests before requesting the host window:

```bash
node --check scripts/deploy-search-freshness.mjs
node --test scripts/test-deploy-search-freshness.mjs
```

The tests use only synthetic temporary `fake-config` files, never production
configuration. They verify exact arguments, equal-width byte changes, original
inode/ownership/mode, UTF-8 and CRLF preservation, full-file compare-and-swap,
symlink/hardlink rejection, lock failure and concurrent foreign file changes.
Layer and whole-filesystem proof tests use synthetic digests and a fake
filesystem in a VM; they cannot open host image or provider paths. The
Linux-only default flock/in-place-write test is skipped on macOS. Stage the
reviewed test file with the guard and run it in the later authorized Linux
window before activation; a local macOS pass is not that Linux evidence.
The deployed application source tests remain the separate acceptance evidence
for cache expiry, Safety normalization, routing and driver measurements.

#### Build and candidate checks

The infrastructure coordinator must release one SIM build window after the
operations commit review. While COP owns that window, keep SIM preparation
offline: no image build, image tag change, container recreation or `.env` edit.
Never restart Docker, prune images, alter shared PostgreSQL or probe broad
provider workloads to create headroom.

After the window opens, stage a Git archive of exactly the source revision in
a new private context, such as
`/home/voldzi/sim-search-freshness-90e1d8d0cc50`. Stage the reviewed guard, its
synthetic test file and
`apps/situation-data-api/Dockerfile.search-freshness` from the operations
commit separately and verify their SHA-256 values. The context must not
contain `.env`, credentials, user/provider data or the working tree's ignored
files. Select only `tsconfig.base.json`, `.dockerignore` and
`apps/situation-data-api/src/search-data.ts` from the exact source archive.
All other build code, lock/workspace/package configuration, Node.js and
package-manager tooling are inherited from the protected old image.
`tsconfig.base.json` is needed only in the build stage and is unchanged
between base `03b842e` and source `90e1d8d`. Never archive or reset the dirty
server checkout, copy a fresh package-manager bundle, or rebuild the runtime
from a moving `node:24-alpine` tag for this release.

All four guard modes require the same exact arguments. With Node.js 24 and
the reviewed script staged, the initial read-only invocation is:

```bash
node /home/voldzi/sim-search-freshness-90e1d8d0cc50/scripts/deploy-search-freshness.mjs \
  --preflight \
  --image sim-situation-data-api:search-freshness-90e1d8d0cc50 \
  --revision 90e1d8d0cc50236429b32476e3fd2f31899cf03c \
  --expected-old-image-id sha256:2f3aa1659d03c5eaf014353071e38f6abc1d2da1419a9ac2205a05b5873a5965 \
  --expected-source-sha256 698e3dd4d978db08cd8ddbc484082327b3743392913ad37b53244cab3a327aaa \
  --expected-dist-sha256 3060a86a481496e701f9f3c1523bb2c95f68825348a285fe7979a090fe4aad1b
```

`--preflight` reads capacity, current SDA identity/health, configuration file
hashes and `.env` file metadata, but not its contents. It creates no lock,
record, image alias or container. It requires at least 12 GiB available on
`/`, X5 and Docker's root directory, and 4 GiB `MemAvailable`. X5 must be a
separate device with UUID `2f93f595-b61b-4eea-9054-7afa9b275b5b`.
Insufficient resources, a newer SDA or a different set of Compose overlays
stops the release instead of weakening the checks.

After preflight passes, protect the existing immutable image and build only
the candidate using the existing default builder. Verify the protected alias
resolves to the recorded image ID immediately before and after this build;
the alias is not itself the trust anchor:

```bash
docker image tag sha256:2f3aa1659d03c5eaf014353071e38f6abc1d2da1419a9ac2205a05b5873a5965 \
  sim-situation-data-api:rollback-search90-03b842e005f1
docker buildx build --builder default --load --pull=false \
  --label org.opencontainers.image.revision=90e1d8d0cc50236429b32476e3fd2f31899cf03c \
  --label org.opencontainers.image.base-revision=03b842e005f103bb02d622bb4fc95f27fbea9572 \
  --label org.opencontainers.image.base-image-id=sha256:2f3aa1659d03c5eaf014353071e38f6abc1d2da1419a9ac2205a05b5873a5965 \
  -t sim-situation-data-api:search-freshness-90e1d8d0cc50 \
  -f /home/voldzi/sim-search-freshness-90e1d8d0cc50/apps/situation-data-api/Dockerfile.search-freshness \
  /home/voldzi/sim-search-freshness-90e1d8d0cc50
```

The build stage may install development dependencies with the inherited frozen
lockfile to compile the selected source. None of those dependencies or other
build outputs enter the final runtime. The runtime inherits the entire exact
old image and appends only two separate COPY layers: the selected search source
and compiled search module. There is no runtime RUN, package installation,
configuration replacement or OS/library upgrade. The historical application
Dockerfile remains unchanged.

Run the exact invocation above with `--check` instead of `--preflight`.
It must verify the candidate image ID, source/compiled hashes, Node version,
image runtime configuration and the unchanged application/observability/schema
manifest. Only `src/search-data.ts` and `dist/search-data.js` are excluded from
that unchanged-code manifest. This selected manifest and Node version alone
do not prove an unchanged OS or complete dependency tree. The additional
provenance gate must match the candidate's whole original RootFS layer prefix
to immutable image ID `2f3aa165…`, with exactly two new distinct file-copy
layers and the required base-image label.

The guard also hashes the complete filesystems of both **offline images**, not
the live SDA filesystem or its data mounts. It compares regular-file content,
mode/UID/GID, directory metadata and symlink targets without following links.
The only content exclusions are the two reviewed changed files, Docker-created
`/etc/hostname`, `/etc/hosts`, `/etc/resolv.conf`, and the virtual `/proc`,
`/sys`, `/dev` subtrees. The two reviewed files must still be regular files
with unchanged mode/UID/GID; their exact content hashes are checked separately.
OS files, native libraries, `node_modules` and every
other image file remain in the comparison. An unreadable/unexpected entry,
race, proof bound, timeout or mismatch rejects the complete proof; no entry is
silently omitted. Reads stream through a bounded buffer, with limits of
128000 entries, 512 MiB per file and 64 path levels.

Each filesystem/code proof and the compiled projector fixture runs in a
temporary no-network, read-only container with dropped capabilities, 256 MiB
memory, 0.5 CPU and 32-process limits. It cannot request a provider or
PostgreSQL. A new base, dependency change or any unreviewed runtime difference
is a failed gate, not permission to relax the comparison. Local synthetic
tests are not evidence that Linux flock/pwrite or these actual Docker/image
checks have passed; those remain separate gates in the authorized host window.

The whole-filesystem proof covers content, type, mode, UID/GID and symlink
targets, not extended attributes, ACLs, capabilities or timestamps. Before
cutover approval, the coordinator must also accept the two appended layer
metadata: their actual uncompressed tar SHA-256 must equal the reported
DiffIDs; only each exact reviewed regular file and unchanged ancestor
directories may be present. Reject whiteouts, links, devices, FIFO, sparse or
duplicate effective paths, traversal and unvalidated PAX/GNU metadata.
Validate relevant xattrs/ACLs/capabilities and parent directory timestamps
against the immutable old image, or fail closed. Use a reviewed existing
parser in a bounded streaming check; do not save a large Docker archive or
introduce an unreviewed handwritten tar parser. This metadata acceptance is
still pending and is not supplied by the synthetic VM tests or a `--check`
result. Do not invoke `--apply` until that independent gate is accepted.
Keep both immutable images and their aliases through joint acceptance.

#### Activation and return

Candidate checks and a healthy image do not authorize activation. Obtain the
coordinator's explicit cutover confirmation, then invoke the same reviewed
script and five arguments with `--apply`. The only authoritative image value
it may edit is `DRIVER_MEASUREMENTS_IMAGE` in `/srv/sim/.env`. Its exclusive
deployment marker, Linux FD flock, byte-level compare-and-swap, inode/mode/
owner checks and one positional write preserve every non-image byte. There
is no configuration copy, temporary replacement, truncation or serialization.
Inherited image overrides are rejected. Do not enable shell tracing or export
environment/configuration hashes outside the private process and record.

Activation uses project `sim` and exactly these existing overlays:

- `/srv/sim/docker-compose.yml`;
- `/srv/sim/docker-compose.x5.yml`;
- `/srv/sim/docker-compose.driver-measurements.yml`.

Only `situation-data-api` may be recreated, with `--no-deps --no-build
--pull never`. Preserve all environment values, effective Compose settings,
mounts, internal networks, image startup settings and other container IDs.
Current driver pilot/revocation flags remain unchanged; measurement outputs
stay `shadow_only`. No database migration is involved.

The private mode-0700 directory printed as `recordDir` under
`/srv/sim/.deploy-search-freshness-backups/` stores mode-0600 metadata records:
image IDs/pins, file identity, private hashes and runtime invariants only. It
also records the unchanged offline-filesystem and base-layer digests under
record schema `sim-search-freshness-image-only/v2`; it does not contain `.env`
bytes or secret values. The earlier v1 operations plan was not activated and
its narrower selected-code proof is not accepted by this guard. If activation
fails after a
verified pin write, automatic rollback is permitted only while this release
still owns the exact image/configuration/runtime state. An incomplete or
unverified write stops without recreation or another write and requires
coordinated inspection; never use a blind restore, shell writer or `.env` copy.

For a later owner-approved rollback, use the same script and five arguments
with `--rollback --record-dir` followed by that exact private record path.
The guard reverifies ownership, full file bytes, inode, overlays and protected
old image before restoring the same-width pin and recreating only SDA.
Other applications are compared with their current rollback-start identities,
not the earlier deployment snapshot, so a separately authorized COP release
does not invalidate a later SDA-only return. Configuration drift or a newer
SDA stops rollback for manual coordination.

After activation, use normal COP processing and the unchanged health gate,
with cache warm-up at the existing cadence. Keep only the permitted scoped
freshness/quality aggregates from that actual processing step. Confirm a
bounded synthetic routing control and the driver flags remain intact. Do not
run the general provider benchmark, gateway-cache bypass, radar workload or
extra domain queries below during this coordinated repair. Accept ADR 0037
only after both services pass their separate source, image and live gates.

### General post deployment checks

These broader checks are for a separately approved routine monitoring/load
window. They are not part of the pinned search freshness repair above, and
must not run while shared PostgreSQL or the host has insufficient headroom.

```bash
curl -fsS http://127.0.0.1:5020/health/live
curl -fsS http://127.0.0.1:5020/api/v1/operations/summary
curl -fsS http://127.0.0.1:5020/situation-data/health/ready
curl -fsS http://127.0.0.1:5020/situation-data/api/v1/observability
curl -fsS http://127.0.0.1:5020/search-data/api/v1/observability
python3 scripts/smoke-provider-gateway.py --base-url http://127.0.0.1:5020
pnpm benchmark:providers -- --base-url http://127.0.0.1:5020 --requests 100 --concurrency 20
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
`/flight-data/api/*`, `/situation-data/api/*`, `/search-data/api/*` and
`/safety-data/api/*`. It keeps successful `200` responses valid for 10 seconds
and may serve them stale on backend errors during deploy. This is intended to
protect COP polling loops from brief `502` windows while a single backend
container is recreated.

Use `?nocache=1` or an `Authorization` header when diagnosing an endpoint and
the gateway cache must be bypassed. The response header `X-SIM-Gateway-Cache`
shows nginx cache status such as `MISS`, `HIT`, `STALE` or `UPDATING`.
Gateway responses on these routes use `Cache-Control: private, max-age=10`
regardless of longer upstream provider cache headers.

The same gateway compresses JSON, GeoJSON, JavaScript, CSS, text and SVG
responses larger than 1 KiB with gzip level 5. This is especially relevant for
flight snapshots and map feature collections; COP remains the public fan-out
layer, so browsers still must not query SIM directly.

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

## Provider Latency Gate

`scripts/benchmark-provider-latency.mjs` runs bounded concurrent GET traffic
against health, flight, OSM communication tower, mobile coverage and safety
summary paths. It records throughput, median, p95, p99, maximum latency, HTTP
status distribution and failures. The command exits non-zero when any response
fails or a path exceeds its documented p95 budget.

By default it measures the complete gateway path, including the ten-second
nginx cache. Add `--bypass-gateway-cache` to exercise application caches and
database/read-model access directly without changing the logical request. Keep
the default 100 requests and concurrency 20 for routine post-deploy checks;
higher values are deliberate load tests and should be coordinated with the
operator.

Managed response caches use `Map` insertion order as an O(1) LRU queue. Reads
move an entry to the newest position and eviction removes the oldest key
without scanning the full cache. This matters particularly for the Situation
API aggregate cache, whose production capacity is 10,000 entries.

Flight aggregation uses stale-while-revalidate within the configured stale
window. After the ten-second live TTL, the first caller receives the last valid
snapshot immediately while exactly one background aggregation refresh fetches
the next source snapshot. Source caches deliberately refresh synchronously
inside that background task; enabling stale-while-revalidate at both levels
would add a full extra cache cycle before moving aircraft become visible.
Concurrent COP users therefore neither wait for the public ADS-B provider nor
multiply upstream calls; the normal `staleAfterSeconds` flag still identifies
old tracks.

The ADSB.lol adapter retries short transient connection failures with bounded
backoff. If every enabled flight source fails, the aggregate refresh fails as a
whole: an existing stale snapshot remains eligible, while a cold start returns
an explicit error instead of caching a misleading zero-aircraft snapshot.

## Remaining Optimizations

- Add a dedicated background radar prewarmer if COP needs instant playback
  startup for the latest N frames.
- Add an nginx or CDN cache in front of clean frame URLs if SIM is exposed to a
  high number of simultaneous COP browser clients through the COP backend.
- Add native tiled radar output if browser-side large overlay images become a
  bottleneck at high zoom.

## Verified Production Baseline

Last verified on `docker.home.cz` on 2026-09-21 with 100 requests per provider
case, concurrency 20 and the nginx response cache bypassed:

| Path                                   |    p95 | Errors |
| -------------------------------------- | -----: | -----: |
| flight positions                       | 228 ms |      0 |
| OSM communication towers               |  26 ms |      0 |
| mobile coverage                        |  37 ms |      0 |
| safety administrative boundary summary |  37 ms |      0 |

The flight path measured 3,097 ms p95 before stale-while-revalidate. A sample
flight JSON response compressed from 624,781 bytes to 49,592 bytes. All SIM
containers were healthy with zero restarts after the benchmark, and an
authenticated COP query for mobile-network plus communication-tower layers
returned 40 features with `ONLINE` source health in 5 ms.
