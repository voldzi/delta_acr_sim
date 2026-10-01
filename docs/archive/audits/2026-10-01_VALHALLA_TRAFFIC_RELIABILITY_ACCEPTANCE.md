# Traffic reliability deployment evidence — 1 October 2026

This records completed bounded SIM/Valhalla deployment, generation, expiry,
request-floor and natural-idle checks. It is not acceptance of continuous
fresh-source availability, a new native mapping, or ETA accuracy. No licensed
source records, edge IDs or credentials are included.

## SIM deployment

- Local source commit: `2f9a434`, published on `codex/valhalla-tmc-v11`.
- Pilot host merge: `1831abd` on the existing `codex/cop-chat-full-router` branch.
  Existing tunnel changes and unrelated host edits were preserved.
- Only `csm-sim-situation-data-api` was recreated, at 13:53:26 UTC.
- New runtime image: `sha256:fb86c5a331b1e0df331abf662a49c5f88de229be86390f81275575c74a20974a`.
- Runtime Node: `v24.21.0`; localhost live health and Docker health passed.
- X5: separate `/dev/sdb1`, UUID `2f93f595-b61b-4eea-9054-7afa9b275b5b`.
- The mode-0600 quota transition reserved all three feeds until at least
  13:58:25.066 UTC. No provider token, `.env`, endpoint, network or database
  change was made. The preceding situation image was retained.
- Full local application tests: 293 passed on Node 24.20.0. The merged host
  situation source passed 154 tests in an isolated Node 24 build container.
  Its first run lacked a read-only SQL fixture; repeating with that fixture
  passed. Host OpenAPI Ruby validation was unavailable; binding JSON parsed
  there and full OpenAPI validation passed locally (139 paths, 223 schemas).

## First live sample — 14:01:04 UTC

Health 200, unauthenticated internal status 401, authenticated status/feed 200,
active dataset and ordinary Valhalla car route all passed. The fixed Prague
route returned 5,262 m / 900 s; these are engine outputs, not verified journey
ground truth. Sample outcome was `transition`, not full acceptance: the old
Valhalla updater did not yet report a trusted overlay deadline/generation.

TFP sample:

- HTTP start: 14:00:05.712 UTC; response/content check: 14:00:14.895 UTC.
- Download duration: 9,182 ms; next eligibility: 14:05:05.712 UTC,
  exactly 300 seconds after start, not after completion.
- Validated HTTP Last-Modified: 13:58:05 UTC; phase alignment remains disabled.
- 28,971 records were time-valid, 0 expired and 0 invalid timestamps;
  28,963 had a finite speed in the diagnostic range.
- Remaining validity at sample receipt: 105.786 seconds.

This shows an available fresh snapshot and correct planned eligibility; it
does not by itself establish repeated cycles or physical overlay expiration.

## Initial Valhalla installation and subsequent samples

The operator installed the initial reliability release at 14:06:28 UTC without
restarting the ordinary Valhalla container. The installed updater SHA-256 was
`c26baf4d84bddc0aa05d41d7569a5c364bdc244df12f96f0f2bfec3942891359`.
At 14:08 UTC the hash, active expiry service, active calendar timer and
`true healthy` ordinary container were verified. This confirms installation,
not completion of the joint acceptance gates.

Further captured TFP request starts were 14:05:05.714 UTC and 14:15:05.810 UTC.
Their downloads took 2,833 ms and 3,869 ms, respectively. The latter snapshot
had 28,872 time-valid records, no expired or invalid timestamps, and 141.009
seconds of remaining validity when sampled. The captured starts span
900.098 seconds without accumulating download duration. The intermediate
14:10 start was not captured directly, so this is not a complete consecutive
three-cycle trace. Last-Modified phase varied; phase alignment stayed disabled.

At 14:11:09.780144 UTC the new updater reported a current generation with
19,643 applied flows and 169,653 edges, usable until 14:13:02 UTC. Its guard
logged physical clearing at 14:13:18 UTC; SIM then received a zero/degraded
generation at 14:13:19.758 UTC. SIM's absolute deadline prevents treating the
preceding generation as current after 14:13:02 even while local clearing
finishes. The measured approximately 16-second clear delay is not a promised
latency target and motivated the final block-write optimization.

The final local hardening validates legacy deadlines, avoids repeated empty
cohort writes, clears in 64 KiB blocks and fails closed on interrupted archive
writes. At this initial check it was not yet installed, so its physical clear
latency was unmeasured; the final installation is recorded separately below.
Independent review also found a generation-transition race. The final updater
requires a durable degraded/zero invalidation, HTTP 204 and an exact status
confirmation before positive mmap writes. Crash recovery invalidates old
deadline metadata before mutation. Its synthetic regressions do not substitute
for a new live acknowledgement and expiration measurement.
The new native decoder also remains offline-only.

Final updater source SHA-256:
`372b591ecea8cc5760a79f062a9c3c0590cb2bc054ba6d77d6f1f21b257a41a6`.
Its expiry/transition suite passed 37 tests. Updater, cohort, canary and
physical-inspector tests passed; quota seeding and bounded SIM verifier passed
12 Node test methods. The final report ordering regression confirms a later
microsecond timestamp even with frozen wall time, and excessive backward
clock drift clears rather than publishes current speeds. These checks were
local only at that time; the initial installed `c26baf…` version was not this
final hash.

The first physical inspector included the TAR's `index.bin` metadata by
mistake. Its 974 nonzero words were not traffic speeds. The inspector now
checks only `.gph` speed records and its synthetic index regression passes;
the corrected live scans are recorded below. Do not cite the earlier count as
expired speed evidence or infer a clean archive solely from an empty ledger.

At the next connection attempt both internal names failed DNS resolution;
direct bounded queries to both configured internal resolvers timed out.
No VPN, DNS, firewall or other network setting was changed. Final installer
verification, a technical sample captured during a current window, corrected
physical scanning, repeated expiry latency and natural idle behavior were
pending until access returned. Existing source and network settings,
the map release and the provider polling minimum remain unchanged.

## Final installation and current-window checks — 15:39–15:52 UTC

After the operator confirmed installation, SSH access returned. At 15:41 UTC
the installed updater matched the final SHA-256 above. The expiry service had
been active since 15:39:39 UTC and the one-minute calendar timer was active.
The ordinary Valhalla container remained healthy with zero restarts, its
unchanged start time of 29 September at 10:53:31 UTC, version 3.8.3 and the
same active release `20260929T081714Z`. The weekly build's last-success record
still referred to that release; the last healthcheck succeeded at 15:29:44 UTC.
The next weekly build was scheduled for 4 October at 00:42:12 UTC.

The unchanged SIM situation image was healthy on Node 24.21.0. A separate X5
mount with the expected UUID and the writable traffic-cache bind were verified
again; the timing-only quota file had mode 0600. Valhalla had 32 GiB free and
approximately 2.1 GiB available memory. No token, network, database, source
configuration or ordinary Valhalla restart was part of this final installation.

Two bounded localhost verifications passed all current-window checks:

| UTC sample | Applied flows | Applied edges | Synthetic Prague route | Route latency | Usable until UTC |
| --- | ---: | ---: | --- | ---: | --- |
| 15:41:30 | 15,979 | 137,636 | 4,811 m / 788 s | 2,135 ms | 15:44:45 |
| 15:46:15 | 15,923 | 136,851 | 4,811 m / 800 s | 2,139 ms | 15:49:49 |

Both samples returned live health 200, unauthenticated control status 401,
authenticated status/feed 200, acknowledged current generations and the exact
dataset `sim-routing-2026-09-29-1790679143`. Route and status generations agreed
before and after the calculation. These are engine outputs, not independently
measured journey times. They do not establish an ETA improvement percentage.

Corrected physical scans at 15:41:36 and 15:46:14 UTC examined 489 `.gph` tiles
and 23,781,364 speed records. Their nonzero counts were respectively 137,636
and 136,851, exactly matching the edge ledger and reported applied counts.
These scans prove positive generations were written; they are not expired-zero
evidence. The guard separately logged clearing at 15:44:49 UTC for the deadline
15:44:45, approximately four seconds later. A zero scan was not captured in
that first window and is therefore not inferred from the journal alone.

TFP HTTP starts captured at 15:40:07.503 and 15:45:07.505 UTC were 300.002
seconds apart. Durations were 4,383.861 and 2,465.428 ms; their snapshots held
22,468 and 22,422 time-valid records with no expired/invalid timestamps.
Remaining validity at receipt was 195.017 and 213.931 seconds. At 15:52:03 UTC,
the next captured start was 15:50:07.794, an interval of 300.289 seconds, with
22,892 time-valid records and no expired/invalid timestamps. The new generation
reported 16,279 flows on 140,475 edges, usable until 15:54:52 UTC. HTTP
Last-Modified varied across 15:39:57, 15:45:01 and 15:50:05; phase alignment
remained disabled rather than assuming a stable publication phase.

An aggregate-only localhost observer was started at 15:52 UTC. Its own feed
GET uses the existing gated provider/cache path while a lease is already
active; it neither creates a vehicle lease nor bypasses the 300-second floor.
It has a 30-second observation interval and a 20-minute budget. Its original
nine synthetic tests covered spacing, natural idle, quota invariance, malformed input,
missing token, expired-current rejection, output sanitization and body bounds.
Independent review subsequently hardened the helper's monotonic clock, quota
I/O budget, counts consistency and provider-error handling. Those helper-only
changes do not modify the production service, updater or running observation.
Its final result and a post-expiry physical/route check are recorded separately;
one current sample alone must not be called full acceptance.

## Expired generation and ordinary routing — 15:54–15:55 UTC

For the generation with `usableUntil=15:54:52 UTC`, SIM's next captured status
at 15:55:03 UTC was degraded with zero applied flows/edges and a new clearing
generation updated at 15:54:59.150365 UTC. The corrected physical inspector
completed at 15:55:10.512 UTC: all 23,781,364 speed records across 489 tiles
were zero, the applied-edge ledger was empty and matched the physical count,
and the report was degraded with zero applied edges. This is direct archive
evidence, not an inference from the healthcheck or ledger alone.

The post-expiry synthetic car route returned HTTP 200 through ordinary Valhalla,
5,262 m / 900 s, with the same degraded/zero clearing generation before and
after its calculation. Its latency was 7,798 ms. It did not return the earlier
4,811 m / 800 s current-generation result. The route's traffic status did not
claim live speeds; this proves ordinary routing and this route-cache boundary,
not a general latency SLA or verified journey-time accuracy.

The provider returned HTTP 304 at 15:55:08.056 UTC after the request start at
15:55:07.856. Content time stayed 15:50:12.937 and Last-Modified stayed
15:50:05. At receipt all 22,892 cached flow records were expired, with no
invalid timestamps; no freshness was manufactured from the successful check.
The technical verifier therefore reported `transition`, not failure or fresh
traffic acceptance. The car test extended the normal activity lease to
16:10:07.869 UTC; subsequent observation does not create additional road leases.

## Provider availability limitation observed during acceptance

At the HTTP start 16:00:07.858 UTC, the request returned 200 after 4,408.393 ms
with Last-Modified 15:55:09. Its 22,463 flow records were all expired by the
16:00:33 sample, with no invalid timestamps. At 16:05:07.860 UTC, another 200
response after 2,363.924 ms carried Last-Modified 16:00:12; all 21,528 records
were expired by 16:05:33. These starts were respectively 300.002 seconds apart.
SIM and Valhalla stayed degraded with zero applied speeds rather than
pretending those successful responses were live traffic.

The recent Last-Modified changes occurred at 15:39:57, 15:45:01, 15:50:05,
15:55:09 and 16:00:12 UTC, intervals of 304, 304, 304 and 303 seconds.
This is a short observed publication-header sequence, not confirmation of the
provider's schedule or a guarantee that Last-Modified equals publication time.
It suggests a polling/publication phase mismatch for investigation, but does
not authorize faster requests, extended source expiry or enabling the existing
fixed-phase experiment. The configured phase flag was verified false and the
refresh floor was 300 seconds. Continued all-fresh availability and better ETA
are therefore not claimed, even if local freshness/expiry acceptance passes.

The next source-timing step is to validate the meaning and cadence of the
provider's publication header against consecutive eligible snapshots, then
test an explicitly bounded publication-aware schedule while preserving the
300-second floor and every source deadline. No contact with the provider or
configuration change was made by this acceptance run. The graph-native
direction/hierarchy work remains an independent gate; the TMC geometry has
already prevented promotion of wrong-corridor candidates, not supplied new
live speed observations.

## Cadence and independently confirmed idle — 15:52–16:12 UTC

The finite observation captured three TFP HTTP starts during its run:
15:55:07.856, 16:00:07.858 and 16:05:07.860 UTC. Both intervals were 300.002
seconds. It collected 40 samples over 1,200.008 seconds with zero sample
errors and zero spacing/deadline violations. It observed both a current
generation and expired cohorts. The single lease extension was the explicit
post-expiry car check described above, not observer-generated traffic.

At 16:10:33.412 UTC, it captured natural `idle`, feed 204, unchanged last
vehicle request 15:55:07.869 and an activity deadline of 16:10:07.869. The
initial helper ended honestly with `incomplete`: its second idle sample did
not satisfy the strict 60-second checkpoint before the 20-minute budget.
This helper result is not rewritten as a pass. Instead, the separate finite
idle verifier was run at 16:11 and again at 16:12 UTC. Both passed all ten
runtime checks, and both matched the initial idle quota exactly:

| Timing-only quota | nextAttemptAtMs |
| --- | ---: |
| static | 1790863505700 |
| dynamic | 1790871307868 |
| tec | 1790871307416 |

The later confirmation was more than 60 seconds after the first idle capture.
Status remained idle, feed remained 204, and neither last vehicle request nor
activity deadline changed. Thus the independent composite evidence confirms
natural idle and no further eligible source start during that interval, while
preserving the original observer's incomplete result.

Walking returned 200 through Valhalla, 3,033 m / 2,573 s, with a 357 ms first
request; bicycle returned 200, 3,816 m / 1,009 s, in 266 ms. The later checks
took 6 and 4 ms respectively. Both are synthetic route outputs; neither
activated the road lease or changed quota. The first idle verification took
0.724 seconds overall and the repeated sample 0.080 seconds. These individual
measurements are not a load-test percentile or production latency SLA.

Final read-only verification at 16:11 UTC again matched the expected updater
hash, a healthy ordinary container with zero restarts and unchanged release
symlink. The healthcheck had succeeded at 16:02:53 UTC. The expiry guard was
active with approximately 29 MiB cgroup memory usage and a 34.5 MiB peak; the
last captured minute updater used 1.322 CPU seconds with a 42.6 MiB peak.
These runtime measurements are separate from the 256 MiB guard memory limit.

The published observer helpers now have monotonic budgets and independently
bounded quota I/O/CLI termination, with 15 observer and 14 idle-verifier
synthetic tests passing. The running initial observation was not hot-patched.
The final source also passed all 293 application tests, typecheck, build,
skeleton and binding OpenAPI validation (139 paths, 223 schemas). Chroma
reindex and a subsequent documentation search succeeded once network access
was available; the earlier unavailable attempt remains part of the history.

The local reliability deployment is accepted in this bounded scope. The
all-expired upstream responses above and offline native hierarchy/direction
gates remain unresolved; no new mapping, improved ETA percentage or continuous
live-speed availability is approved by this record.

## Isolated native/TMC real-graph probe

The decoder was run with network disabled, read-only root filesystem, dropped
capabilities, no-new-privileges, one CPU, 768 MiB memory and no live traffic
mount. Only the exact graph TAR and a private mode-0600 input subset were
mounted. Ordinary Valhalla remained healthy on the unchanged release
`20260929T081714Z` and dataset `sim-routing-2026-09-29-1790679143`.

Graph SHA-256:
`301b222d431aca366841117a1093e26dd763a2c3a721e41f74244e2ce5a22909`.
Static revision:
`10b52da1cef6b14e56c112ce1b78770cccaf6fd77ae96e2e1a01d719e1e01a08`.
Licensed TMC ZIP SHA-256:
`820b66b27f941e95aaa7817a12fbe5e643cbe3305987e312124e448bd2e2926d`.

From 55,150 static references, the unchanged TMC geometries permitted 40,684
bounded corridor inputs. Preparation rejected 12,797 missing road associations,
1,656 endpoints outside 100 m and 13 invalid references. No geometry was
simplified or missing road guessed from coordinates.

A deterministic FRC-stratified subset of 24 references produced:

| Result | References |
| --- | ---: |
| Matched interval candidate | 2 |
| Ambiguous | 3 |
| Unsupported hierarchy transition | 14 |
| No compatible endpoint | 2 |
| Unmatched | 2 |
| Unsupported road form | 1 |

Both matched references had whole-edge candidates and no mutual ownership
collision. They are not necessarily additions to the baseline. The audit is
private and `approvedForLive=false`; nothing was written to the live overlay.
Cross-baseline ownership, independent directional review, hierarchy/restriction
support and a separately approved canary remain required. The observed 14
hierarchy rejections identify the next specific implementation boundary; wider
snap radii or choosing the first route would not resolve it safely.

The completed synthetic native suite passed 69 cases: 20 core checks, 17
Python client methods, 30 actual flat-graph cases and two actual hierarchical
graph cases. Private corridor preparation passed 11 methods. Output-path
regressions prevent overwriting a static/corridor input, helper, configuration
or runtime path. Full local application validation passed 293 tests,
typechecking, build, skeleton and binding OpenAPI checks. The sandbox-only
application test attempt could not open a local socket; the repeat with
local test-port permission passed. Chroma retrieval/reindex became unavailable
when its configured server could not be reached; no reindex success is claimed
for this final revision.
