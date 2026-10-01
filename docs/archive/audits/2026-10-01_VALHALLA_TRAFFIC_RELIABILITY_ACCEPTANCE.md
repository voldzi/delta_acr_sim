# Traffic reliability deployment evidence — 1 October 2026

This is a bounded technical record, not completed joint acceptance or an ETA
accuracy claim. No licensed source records, edge IDs or credentials are included.

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
writes. It is not yet installed, so its physical clear latency is unmeasured.
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
local only; the initial installed `c26baf…` version is not this final hash.

The first physical inspector included the TAR's `index.bin` metadata by
mistake. Its 974 nonzero words were not traffic speeds. The inspector now
checks only `.gph` speed records and its synthetic index regression passes;
the corrected live scan remains pending. Do not cite the earlier count as
expired speed evidence or infer a clean archive solely from an empty ledger.

At the next connection attempt both internal names failed DNS resolution;
direct bounded queries to both configured internal resolvers timed out.
No VPN, DNS, firewall or other network setting was changed. Final installer
verification, a technical sample captured during a current window, corrected
physical scanning, repeated expiry latency and natural idle behavior remain
to be verified after access returns. Existing source and network settings,
the map release and the provider polling minimum remain unchanged.

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
