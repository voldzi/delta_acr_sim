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

The final read-only service inspection confirmed `ExecStartPre` invokes
`valhalla-codex-maintenance prune-old-releases` before each weekly build.
The installed weekly updater matches the repository SHA256
`07bd5e3c6f93f5a94cc36443a4d1f7627316b96e23562527a3e25f42e208e8e2`.
This verifies the pre-build cleanup is installed; it is not a guarantee that
future source sizes will fit the disk.

The private offline wrapper's deployed executable permission was corrected
to `0755`, and its SHA256 matches the published source:
`c57c8b7367fe641b954ee225813e950fcf310df5e4cf33677e1b3bf5e26a80f7`.
This metadata-only correction did not restart ordinary Valhalla or activate
the native candidate map.

## Subsequent authorized same-flow A/B pilot, 20:52 CEST

After the deployment request, `scripts/run-valhalla-native-canary.sh --start`
staged a new graph-native pilot, not the historical v3 canary. Ordinary
Valhalla stayed running with its original September 29 start time, healthy
and restart count zero. No serving traffic archive or map cache was changed.
The isolated sidecar was network-disabled, read-only except its private
result directory and temporary traffic copy, bounded to 1 CPU / 1.5 GiB and
180 seconds. It used the pinned image's Python Actor with a fixed local
departure time and the same normalized SIM snapshot for both variants.

The initial snapshot was expired: 45 candidate records had validity ending
20:46:33 CEST. The pilot did not lengthen expiry or bypass quota. It waited
for the scheduled refresh at 20:51:55 CEST. The subsequent valid snapshot
enabled the comparison, completed at **20:52:47.705559 CEST**.

| Check | Observed result |
| --- | --- |
| Existing baseline applied edges in private copy | 56,255 |
| New candidate fresh flow records | 50 |
| New candidate applied directed edges | 311 |
| Forward routes, FRC 1–7 | 13/13 paired, using added edges |
| Forward shapes changed | 0 |
| Forward duration changes | 13; range -78.419 to +13.285 seconds |
| Reverse routes | 13/13 paired; 0 shape changes |
| Reverse duration delta range | -56.174 to 0 seconds |
| Walking / bicycle controls | Both paired, identical shape and time |
| Routes using no added edge in either variant | Identical shape and time |
| Snapshot valid at completion | Yes |
| Automated pilot passed | Yes |
| Geographic / live approval | Still false / required |

Reverse-duration changes were observed on routes using added directed edges;
these may be lawful detours, but do not independently establish carriageway
correctness. Do not describe this as all opposite-direction routes unchanged.
This is evidence of functional current-speed consumption, not ETA accuracy.

Private report SHA256:
`4dbea53c60d4d62a814ed17e1928b2a32f13662444fd64cfc90cbe5004426984`.
Candidate artifact SHA256:
`5d6b5799178391ad04a5b37a16ce69dc9b6e1db7554ee02e14c302ce917b0029`.
Both remain in operator-only directories / ignored local data, never Git.

The launcher returned status 1 **after** the successful report because its
EXIT cleanup used `read` on Docker's non-newline-terminated CID file under
`set -e`. This did not invalidate the completed Actor comparison or leave a
container running. The cleanup was fixed to consume that case; its own empty
control directory was removed after verifying the container was absent.
The private report was independently recovered and checked. The corrected
launcher had syntax/fixture verification at that point. A second live computation
was subsequently completed as recorded below.

The separate reviewed first-wave selector and rollback are prepared. It can
accept only the 10 target-evidenced, same-shape forward references after **actual
operator geographic review**, not all 427. It is not installed/activated yet.
The limited maintenance key cannot perform that protected install; the
operator must run the staged root-only installer after the geographic gate.
Nine new pilot tests, thirteen selector/promotion tests, the existing updater
suite, 37 expiry tests, physical-inspection test and skeleton checks passed.
No REST contract changed; binding OpenAPI remains unchanged.

The selector suite includes complete synthetic speed-archive activation and
rollback for the same dynamic revision: the baseline cache stays byte-identical,
the runtime matcher changes, and the added edge is physically zero after return.
The application's full 300 tests, typecheck and build passed again after the
deployment tooling changes. Installed runtime updater hash still remains
`372b591ecea8cc5760a79f062a9c3c0590cb2bc054ba6d77d6f1f21b257a41a6`;
new `49d9fc32f945a201290d777cb868b55e19c4bfb99ac806e62cfa32279a3f8289`
is only staged. The local Python Actor reports version 3.8.3, matching the
serving image. Serving Valhalla remains healthy with restart count zero.

`scripts/prepare-native-geographic-review.py` generated an ignored 0600
operator sheet with 10 numbered target-evidenced sketches and optional user-clicked OSM links.
It makes no network requests automatically and grants no approval. The sketches
show source point order and candidate direction but omit surrounding roads;
the operator must independently establish the actual road/carriageway before
using the installer confirmation flag. This is not a public dataset export.

### Target-specific proof, 21:27 CEST

The second isolated same-snapshot Actor 3.8.3 computation completed at
2026-10-01 19:27:47 UTC. Its private report SHA-256 is
`faa70eef659aaf91029e41b2c2fcdac65bead2c14a99a07447b3c5aada714d70`.
It is the only pinned promotion proof; the previous 13-route report is historical.

| Check | Result |
| --- | --- |
| Baseline applied directed edges | 45,286 |
| Candidate fresh records / directed edges | 40 / 231 |
| Forward routes using their own target edges | 10/10, FRC 1–6 |
| Forward shape changes | 0 |
| Forward time changes | 10; -107.471 to +40.500 seconds |
| Reverse routes using target edges | 0/10 |
| Reverse shape / time changes | 0 / 0 |
| Walking, bicycle and unaffected controls | Unchanged shape/time |
| Snapshot still valid at completion | Yes |
| Geographic review / live approval | Still required / false |

The launcher returned status 2 after this successful computation because its
source was edited during execution and Bash resumed reading at a shifted offset.
The private report was independently recovered and verified; no pilot container
remained and serving Valhalla stayed healthy with zero restarts. The launcher
now parses its full `main` body before executing it. Syntax/local tests verify
that repair; another live run has not been performed merely to retest transport.

Promotion requires positive reference-specific target-edge evidence, not an
intersection with any neighbouring addition. The builder pins this report and
Actor version 3.8.3. A private 10-section review sheet is available locally at
`data/valhalla/tmc/native-first-wave-target-review-20261001.html` (ignored, 0600).
The operator-only installer remains staged, not installed. This proves that
current segment speeds can change route duration; it does not measure ETA
accuracy against actual journeys.

### Operator installation and live application, 21:54–21:55 CEST

The operator executed the staged root installer with
`--geographic-review-confirmed`. This records operator attestation; it is not
independent evidence of observed journey-time accuracy. Installed updater SHA-256
matches `49d9fc32f945a201290d777cb868b55e19c4bfb99ac806e62cfa32279a3f8289`.
Serving Valhalla remained healthy with restart count zero; update timer and the
independent expiry service remained active, and updater runs succeeded.

The first fresh vehicle lease was requested through SIM at 19:53:13 UTC.
Its initial response was correctly `warming`, not positive acceptance. At
19:54:06 UTC the updater applied the reviewed selection:

| Live application check | Observed result |
| --- | --- |
| Runtime matcher | `openlr-trace-v2+native-reviewed-v2-c73c57a36b97413e92b0` |
| Mapped reference segments | 35,649 (baseline 35,639 + 10) |
| Mapped directed edges | 305,028 (baseline 304,961 + 67) |
| Applied fresh flows / directed edges | 4,810 / 39,295 |
| New reviewed edges in active ledger | 28 of 67 |
| Source observation / usable until | 19:51:01 / 19:56:56 UTC |

The 19:55:11 UTC SIM verifier returned `technical_sample_pass`: synthetic
Prague car route HTTP 200, active current generation acknowledged by SIM,
matching September 29 dataset, bounded validity and unauthorized control
requests rejected with HTTP 401. Route output was 5,618 m / 805 seconds; this
is a smoke result, not a paired accuracy comparison with the earlier warming
response. Provider returned 7,043 fresh records, no invalid timestamps and no
provider error. No raw records, reference IDs or geometry were disclosed.
Natural expiration/physical clearing is recorded separately below.

At 19:55:36 UTC, read-only physical inspection found exactly 39,295 nonzero
speed records and 39,295 ledger entries, matching the report. The generation
deadline was 19:56:56 UTC. The independent expiry service logged its natural
clear at 19:57:03 UTC (approximately seven seconds after the deadline). At
19:57:32 UTC, inspection confirmed **zero** nonzero speed records and an empty
edge ledger, with `degraded`/zero-applied state; no source timestamps or validity
were extended. Serving Valhalla still reported healthy with restart count zero.
The SIM route acceptance prevents expired generations being presented as
current; this record does not claim zero physical-clearing latency.

This completes the bounded first-wave deployment check: installed identity,
fingerprinted matcher, real new-edge application, SIM route acceptance and
natural expiry clearing. It is not national rollout of the other 417 references,
long-term provider availability, or independently measured ETA accuracy.
