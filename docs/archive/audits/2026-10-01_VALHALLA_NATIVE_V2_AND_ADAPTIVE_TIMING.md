# Valhalla native v2 and adaptive publication timing evidence

Date: 2026-10-01. Owner: SIM / Valhalla.

## Outcome and interpretation

The adaptive publication clock is installed in the pilot situation service.
It retains the provider's 300-second request floor, persisted restart gates,
original measurement times and provider expiry. No expired flow is made current
by a fetch, HTTP 304, phase alignment or mapping candidate.

The hierarchy-aware graph-native decoder, full national shadow batch,
deterministic replay, independent geometry falsification and current-baseline
ownership review are complete. Their 427 disjoint new candidates are private,
**not activated**, and explicitly `approvedForLive=false`. Existing
`openlr-trace-v2` mapping remains active. There is no ETA-accuracy measurement
or claim of a complete national live-speed map.

## Immutable input identities

| Input | Verified identity |
| --- | --- |
| Active release | `20260929T081714Z` |
| Routing dataset | `sim-routing-2026-09-29-1790679143` |
| Valhalla version | `3.8.3` |
| Graph SHA256 | `301b222d431aca366841117a1093e26dd763a2c3a721e41f74244e2ce5a22909` |
| Static revision | `10b52da1cef6b14e56c112ce1b78770cccaf6fd77ae96e2e1a01d719e1e01a08` |
| TMC table | Czech v11.0, CID 11 / TABCD 25 |
| Licensed ZIP SHA256 | `820b66b27f941e95aaa7817a12fbe5e643cbe3305987e312124e448bd2e2926d` |
| Corridor revision | `5a5755c122128ff3f5c44ccff5526da531b1a21d05552db919d5d394772c2b9c` |
| Decoder | `openlr-native-v2` |
| Staged native binary SHA256 | `e34ce1dda67ebc2e2b1f2a7e59b01f0f604965ffa949b3161e3065ec5f8fb68a` |
| Native cache key | `003a15ce671bdfbc4062aa0767375c8c4b1f55d0c6a037485e5092334bd3443e` |
| Native audit file SHA256 | `b32b3a2cd3a9c6ca2bff449ca9f7cd987d24ecf09f984469584404f95b6b71a7` |
| Directed shapes file SHA256 | `99780478e286b35d5e0d21f42a0e1b3a66a403b7875bad654981fc9157e82d04` |
| Current baseline file SHA256 | `2281f0fd88d64a015dcf335db4e9fe793a2e2ec6fa0bd46af95a700b9563d252` |

The licensed ZIP, normalized snapshots, private IDs and geometry are ignored
local data, mode 0600, never Git fixtures/public telemetry. The current baseline
was exported by the operator into an explicitly scoped private audit copy;
root permissions were not bypassed to obtain it.

## Full source accounting

Preparation considered all 55,150 normalized references. The default bounded
240-reference sample was explicitly replaced by `--max-segments 100000` for
this national offline batch. No eligible reference was omitted.

| Preparation outcome | References |
| --- | ---: |
| Eligible for independently linked TMC road corridor | 40,684 |
| No linked TMC road geometry | 12,797 |
| Endpoint outside road corridor | 1,656 |
| Invalid reference | 13 |
| Total | 55,150 |

| Native result | References |
| --- | ---: |
| Matched interval path | 4,061 |
| Ambiguous | 13,708 |
| No endpoint | 3,406 |
| Unmatched | 15,756 |
| Unsupported FOW | 328 |
| Unsupported restriction | 3,422 |
| Search limit | 3 |
| Total eligible processed | 40,684 |

Two complete runs produced identical native counts, directed interval maps and
whole-edge maps. There were no unsupported-hierarchy results. The real graph
was mounted read-only; helpers had no network, live traffic mount or root
filesystem. Serving Valhalla was not stopped or restarted.

Of the 4,061 matched paths, cross-reference ownership rejected 278 references;
59 further paths had no eligible whole edge. The initial whole-edge candidate
set therefore had 3,724 references. These were not live approvals.

## Independent direction and ownership gates

The exporter read exact directed shapes for all 28,454 distinct claimed graph
edges. Its private gzip output was 805,993 bytes. Graph SHA256 and size/mtime
were verified before and after export; no remote tile/traffic fallback existed.

The separate Python reviewer checked ordered source LRPs, directed bearings,
clipped interval connectivity and the entire path against the licensed TMC
road geometry. It did not invoke the native path search or fastest-route API.
Nonzero offsets were deferred rather than reconstructing missing untrimmed
path provenance. This is independent automated falsification, not human
carriageway adjudication or an independent trip-time reference.

| Direction verdict | All matched paths | Whole-edge candidates |
| --- | ---: | ---: |
| Geometry/direction pass | 3,845 | 3,535 |
| LRP bearing mismatch | 145 | 134 |
| LRP order/direction mismatch | 1 | 1 |
| Offset review required | 70 | 54 |
| Total | 4,061 | 3,724 |

The active map contained 35,639 references and 304,961 distinct edge claims.
Every active claim blocks the whole edge, even if a new candidate only touches
part of it. Previously active reference IDs cannot be replaced. The gate
recomputes native cross-reference claims, including claims by rejected paths,
and binds its direction verdict artifact to the exact native-audit file hash.

| Final ownership outcome | References |
| --- | ---: |
| Already active reference, left unchanged | 3,473 |
| Independent direction did not pass | 102 |
| Native collision or no whole edge | 35 |
| Overlap with any active edge | 24 |
| Disjoint isolated-canary candidate | 427 |
| Total matched paths accounted for | 4,061 |

The remaining 427 contain 2,870 whole directed edges. None is written to a live
cache or `traffic.tar`. The native bearing rejections do not establish defects
in the existing baseline, whose paths were not the shapes under this review.

A read-only existing SIM feed check at 17:41:34 UTC found 63 fresh valid flow
records belonging to 63 distinct members of the 427-reference cohort, with
zero expired/invalid cohort records in that snapshot. Other cohort members
were absent, not inferred current. No lease was extended by the cohort check;
no raw provider record, ID, geometry or control token was printed.

## Timing deployment and live evidence

Commit `932460e` installed adaptive re-anchoring and bounded cadence learning;
the host's corresponding cherry-pick was `3467c42`. A final live trace exposed
an additional exact boundary defect: starting four milliseconds late rounded
the next nominal slot up by an entire five-minute period. Commit `5c3f3a1`
fixes at most one second of that jitter by delaying the near-boundary slot to
the hard request floor, never requesting early. Host cherry-pick: `d7fc650`.
Larger phase misses retain ordinary phase selection, with no freshness promise.

Only `csm-sim-situation-data-api` was recreated. Current image:
`sha256:6c359768d459e36753466303ca2596f5b14dd0e99e2401ff3f93e24b8cc73773`,
started 17:35:32.683962351 UTC and healthy. Its prior image is retained as
`sim-situation-data-api:before-jitter-fix-20261001`. The `.env` remains mode 600.
The opt-in flag is true; no provider key, endpoint, network or other service
was changed. Before each deployment the separate X5 mount and UUID
`2f93f595-b61b-4eea-9054-7afa9b275b5b` were verified with over 117 GiB available.
The persisted reservation 17:36:20 UTC survived restart unchanged.

One fixed synthetic Prague car route returned HTTP 200, Valhalla, 5,262 m,
900 seconds during expected warming. This is routing availability, not
positive live ETA acceptance. Unauthenticated control access returned 401.
Its finite lease ends 17:51:14.876 UTC; the observer never sends car routes.

| Provider request start UTC | HTTP | Duration ms | Last-Modified UTC | Fresh at receipt | Next reserved UTC |
| --- | ---: | ---: | --- | ---: | --- |
| 17:36:20.022 | 200 | 3,007 | 17:36:10 | 14,618 | 17:41:25 |
| 17:41:25.010 | 200 | 1,987 | 17:41:12 | 14,088 | 17:46:27 |
| 17:46:27.013 | 200 | 2,499 | 17:46:15 | 13,155 | 17:51:33 |

Actual start spacing was 304.988 and 302.003 seconds, both above 300 seconds.
Last-Modified denotes publication, not measurement. Source observation/expiry
remain distinct. Short source-validity gaps between generations still exist;
they cause safe degraded/static-speed routing, not artificial freshness.

| Applied generation UTC | Usable until UTC | Flows | Edges |
| --- | --- | ---: | ---: |
| 17:37:07.202433 | 17:41:01 | 10,349 | 88,656 |
| 17:42:07.650489 | 17:46:04 | 9,952 | 85,570 |
| 17:47:06.497546 | 17:51:06 | 9,270 | 79,556 |

Physical scans confirmed 88,656 and 79,556 nonzero records matched the exact
edge ledger and reported counts. The archive has 489 tiles and 23,781,364
possible speed records. The first expiry clear was acknowledged at
17:41:02.398913 UTC, 1.399 seconds after its deadline. The second was
17:46:08.450015 UTC, 4.450 seconds after its deadline. These measured delays
are not a hard real-time SLA.

The third expiry clear was acknowledged at 17:51:07.745876 UTC, 1.746 seconds
after its deadline. The independent physical scan at 17:53:47.758 UTC found
zero nonzero speed records, an empty ledger and a degraded zero report.

The final bounded observer returned `bounded_observation_pass`: 35 samples
over 1,020.010 seconds, three provider starts, zero local/provider errors,
zero violations and zero lease extensions. Natural idle checkpoints at
17:51:39.858 and 17:53:09.862 UTC had exactly unchanged static/dynamic/TEC
quota. The next reserved TFP request at 17:51:33 did not run after lease end.
The observer explicitly retains `fullAcceptance=false`; mapping correctness,
ETA accuracy and physical zeroing require their separately recorded evidence.

The separate idle test returned `idle_non_vehicle_pass` in 1.110 seconds.
Walking (3,033 m / 2,573 s) and bicycle (3,816 m / 1,009 s) both returned
Valhalla HTTP 200. Lease/request timestamps and all three quota entries stayed
unchanged, and the idle feed returned 204. Earlier pre-hotfix observations
were explicitly incomplete/interrupted, not reported as final acceptance;
one began too late to count its first request and another exposed the slot-skip
defect. They do not replace the final successful three-cycle trace.

## Validation and remaining live gate

- Repository: 300 application tests; typecheck, build, skeleton validation and
  binding OpenAPI validation/check passed. OpenAPI has 139 paths / 223 schemas.
- Native isolated suite: 128 checks (20 core, 19 client, 30 flat graph,
  28 hierarchy, 11 corridor, 9 independent direction, 11 baseline).
- Additional audit tools: 4 aggregate cohort and 5 private collector tests.
- Sandbox-only localhost listener restrictions caused an initial test attempt
  to fail with EPERM; the authorized rerun passed all 157 situation tests.
- No manual or automatic candidate activation, direct provider bypass,
  production network change, serving Valhalla restart or fabricated expiry.

Before live native activation, perform stratified human carriageway/direction
review and a separately isolated same-flow route-time A/B canary, followed by
explicit operational acceptance. Re-check the exact graph/static/TMC hashes;
the next weekly graph invalidates every edge map. Do not reuse the historical
v3 canary or enable `TRAFFIC_OPENLR_ROUTE_FALLBACK` as a substitute. Actual ETA
accuracy requires independent observed lawful trip-time evidence.

## Reproduce private offline gates

Run the fixture suite with `bash scripts/test-valhalla-openlr-native.sh`.
For the reviewed graph, operator-scoped artifacts are under ignored
`data/valhalla/tmc/`, mode 0600. New output names are required; the review
writer refuses existing files, input aliases and resolved runtime paths.

```bash
python3 deploy/valhalla/review-native-directions.py \
  --static-cache data/valhalla/tmc/static-segments-native-20261001.json.gz \
  --audit data/valhalla/tmc/native-v2-national-report-20261001.json.gz \
  --shapes data/valhalla/tmc/native-v2-directed-shapes-20261001.json.gz \
  --tmc-zip data/valhalla/tmc/LT_v11.zip \
  --output data/valhalla/tmc/native-v2-direction-review-new.json.gz
python3 deploy/valhalla/review-native-baseline.py \
  --audit data/valhalla/tmc/native-v2-national-report-20261001.json.gz \
  --baseline data/valhalla/tmc/current-baseline-20261001.json.gz \
  --review data/valhalla/tmc/native-v2-direction-review-new.json.gz \
  --output data/valhalla/tmc/native-v2-isolated-candidates-new.json.gz
```

Do not copy private output to the live edge-map cache. Console output is
aggregate only. The shape collector uses an immutable read-only sidecar,
bounded input/output, 1 CPU / 768 MiB and 180-second container timeout.
Cleanup acts only on the Docker ID from its own private CID file, never on a
pre-existing same-name container. The offline native wrapper has the same
ownership rule and a 1,800-second hard bound; no root filesystem is mounted.

## Narrow rollback

Disable `SITUATION_DATA_TPEG2_ALIGN_TO_LAST_MODIFIED` and recreate only
situation-data-api to return to start-based timing, preserving the X5 quota
file and expiry-safe software. Never restore the whole old `.env`, delete a
reservation or roll back to a pre-expiry-protection image. The retained
pre-jitter image is diagnostic recovery, not the preferred timing rollback:
the flag-only rollback keeps the boundary fix and current deadline protection.
Native v2 rollback is simply not selecting its private candidate artifact;
the accepted live baseline has never been replaced.

## Final runtime identity check

At 18:13 UTC, SIM and Valhalla clocks agreed within the sequential SSH checks.
SIM retained the healthy new image. Valhalla remained healthy with zero
restarts, started September 29 at 10:53:31 UTC. Its installed traffic updater
SHA256 was `372b591ecea8cc5760a79f062a9c3c0590cb2bc054ba6d77d6f1f21b257a41a6`.
Map build/activation and healthcheck results were successful; the expiry guard
was active with success status. The current symlink and dataset were unchanged.
The weekly timer remained active with next scheduled build October 4,
00:42:12 UTC. Valhalla had 32 GiB free. No experiment was running or selected.
