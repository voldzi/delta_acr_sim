# Valhalla map refresh and bounded live-speed acceptance — 10 October 2026

## Scope and outcome

The approved download repair completed and atomically activated release
`20261010T174115Z`. Independent national/cross-border routes, the deployed SIM
road path, automatic closure revalidation, fresh speed application and natural
expiry were observed. This closes the map-refresh/fresh-speed monitoring task;
it is not an ETA-accuracy benchmark or a multi-cycle traffic availability SLA.
All timestamps below are UTC (Prague was UTC+02:00).

## Installed identities and map activation

- Build started `2026-10-10T17:41:15Z`; successful activation was recorded at
  `21:35:45Z`, with the weekly unit exiting successfully at `21:35:48Z`.
- Installed weekly updater SHA-256:
  `7a0a602b1f2470dd40e94023b2dec37f804bf1aa7aff09d485f9f4214e590fe0`.
  The operator retained `weekly-update.sh.before-gwdg-20261010`.
- Active symlink: `/srv/valhalla/releases/20261010T174115Z/custom_files`.
  `last-attempt.env` and `last-success.env` agree on this successful release.
  The previous release `20260929T081714Z` remains available for rollback.
- Valhalla `3.8.3`; `tileset_last_modified=1791668067`;
  dataset `sim-routing-2026-10-10-1791668067`.
- Healthcheck succeeded at `21:43:18Z`; container healthy, restart count zero.
  Post-build disk availability was approximately 31.8 GiB.
- The weekly timer remains active (next observed schedule
  `2026-10-11T00:15:50Z`); no second build was started during acceptance.
- Deployed SIM situation-data revision:
  `9592372a3cdccce835435a653cc1a44304cbf8a9`;
  image `sha256:a170158e385ebba35d14097f2bb59f681160c09e4954422c51e0a050bff00bad`.
  No SIM deployment or network/auth changes were needed for these checks.

## Independent routing and closure boundary

Two direct control routes returned HTTP 200 / trip status 0 on the new graph:
Cheb–Ostrava (543.222 km, 498 ms, CZ) and Brno–Vienna
(135.842 km, 638 ms, CZ and AT). These controls requested static speed types;
they validate connectivity/cross-border graph coverage, not live traffic ETA.

The ordinary SIM synthetic car route returned HTTP 200 and the new dataset.
Its first request activated the existing finite vehicle lease. The deployed
SIM emitted `known_closure_graph_revalidated` for the same new dataset with
`approvedClosureCount=1`. The exact deployed revision implements the guarded
revalidation; neither the reviewed approval file nor closure, graph-age or
authentication protections were edited.

## Fresh overlay and graph-specific mapping

The ordinary traffic updater rebuilt the baseline mapping after the graph
change. At `21:55:27Z`, it had mapped **35,642 / 55,150 references (64.63%)**, with
19,508 rejected. The new private cache is
`openlr-edge-map-009b11b534b93c82a857.json.gz` (2,636,860 bytes); its filename
matches the SHA-256 cache-key derivation for `openlr-trace-v2`, the new dataset
and static revision
`10b52da1cef6b14e56c112ce1b78770cccaf6fd77ae96e2e1a01d719e1e01a08`.
The protected mapping content was not copied or published.

The prior native-reviewed selection was explicitly rejected for graph/static
revision mismatch, using the new baseline instead. No old edge IDs or native
selection were promoted. The installed traffic updater SHA-256 is
`49d9fc32f945a201290d777cb868b55e19c4bfb99ac806e62cfa32279a3f8289`;
its live entry point rejects experimental route fallback before network use.
Successful ordinary execution confirms that fallback was not enabled.

At `21:57:09.619Z`, `verify-valhalla-traffic-reliability.mjs`, run inside the
existing SIM container, returned `technical_sample_pass`:

- Unauthorized traffic-status request: HTTP 401; authenticated status and
  normal routing: HTTP 200.
- SIM route and acknowledged overlay: the same new dataset and generation
  `8fe59ab23e9d48ab998f5191dfec55f7`, state `current`.
- `sourceObservedAt=2026-10-10T21:55:01Z`,
  `updatedAt=2026-10-10T21:57:03.201885Z`,
  `usableUntil=2026-10-10T22:00:45.000000Z`.
- **2,195 fresh flows applied to 17,634 directed edges**; total mapped edges
  305,353. Feed: 3,259 fresh flows, zero expired or invalid timestamps.
- Synthetic route: HTTP 200, 159 ms, 5,618 m / 776 s. These values are an
  execution result, not evidence of real-world travel-time accuracy.
- Read-only physical archive inspection at `22:00:17Z` independently counted
  17,634 nonzero records and 17,634 ledger entries across 489 tiles, agreeing
  with the `current` report and expiry deadline.

The verifier deliberately reports `fullAcceptance=false`: one sample does not
prove continuous provider availability, independent directional accuracy of
all references, or a multi-cycle traffic rollout.

## Natural expiry: no reuse of expired speeds

Without changing provider cadence, forcing the updater, or extending validity,
the overlay was cleared at `22:00:49.711Z`, 4.711 seconds after its observed
deadline. This is measured latency, not a hard real-time guarantee.

At `22:01:00.817Z`, the same normal SIM path reported `degraded`, zero applied
flows/edges and the clear generation `017cab68a3354e3c84760e118069372a`.
The feed contained 3,259 expired and zero fresh records. Routing still returned
HTTP 200 (255 ms, 5,262 m / 900 s), without a `current` overlay or reuse of the
previous live-derived route. The verifier's `transition` / exit 2 is expected
for this negative check, not a failed map update.

Read-only physical inspection at `22:01:11Z` counted **zero nonzero speed
records and zero ledger entries**, with a `degraded` report. Together with
the SIM negative path, this verifies actual clearing, not merely relabelling.
Invalid/future/missing timestamps and mixed/expired flows were also covered
by the synthetic regression suite. No invalid provider payload was injected
into production.

## Tests, unchanged boundaries and follow-up gates

- `python3 deploy/valhalla/test-traffic-expiry.py`: **37/37 passed**.
- Situation-data routing-live-traffic and traffic-coordinator tests:
  **20/20 passed** (Node 24.21.0, pnpm 10.33.0).
- Bounded verifier/observer script tests: **22/22 passed**; physical inspector
  fixture: **1/1 passed**; documentation skeleton and whitespace checks passed.
- Positive and negative deployed SIM verifier samples, independent direct
  routes, closure event and aggregate physical inspection are recorded above.
- No provider limits/cadence, serving ports, secrets, reviewed approvals or
  experimental mapping selection changed. All observations used normal finite
  leases and existing authenticated internal APIs. No licensed records,
  trajectories, edge identifiers or secret values are published here.
- On the deployed SIM, `DRIVER_MEASUREMENTS_ENABLED=false` and
  `DRIVER_MEASUREMENTS_REVOCATION_ENABLED=true`; the contract remains
  `shadow_only`. Jízda is not a source of live speeds or ETA in this acceptance.
- Read-only COP check at `22:02:30Z` confirmed
  `COP_DRIVER_MEASUREMENTS_ENABLED=false` and
  `COP_DRIVER_MEASUREMENTS_CLEANUP_ENABLED=true`. Local iPhone source retains
  `DriverMeasurementClient.productionPilotEnabled=false`; this is not a
  readback or functional acceptance of an installed physical iPhone.
- Enabling real iPhone intake still requires joint COP–SIM–iPhone acceptance
  of consent, minimisation, retry/idempotency, revocation/deletion (including
  concurrent batch/revoke), retention/backup policy and device behaviour.
  Any subsequent use in live speeds/ETA requires a separate approval.
- The persistent SIM operational monitor continues on its existing five-minute
  schedule. Its published Valhalla snapshot at `22:00:06.005921Z` reports
  `status=ok`, `severity=info`, zero failures and the exact new active release,
  successful healthcheck and active weekly timer. This one-off Codex
  build/acceptance watcher can be stopped; doing so does not disable weekly
  builds, healthchecks or SIM warnings.
- Rollback uses the retained prior release and guarded activation/recovery
  workflow. Never carry traffic mappings across a graph rollback; first clear
  the overlay and require graph-specific remapping/acknowledgement. Retain
  independent expiry protection and the SIM deadline checks.

Mapping coverage is not ETA accuracy. No percentage of travel-time correctness
or generalized improvement follows from these technical checks.

Chroma retrieval/reindex was unavailable: the named-identity handoff refused
replacement identity, and the documented identity-free fallback could not
connect to its server. The index service was not rebuilt or restarted. This
documentation-only change did not rerun the complete repository test/build
suite; the targeted checks above were rerun and production evidence was taken
from the actual deployed identities rather than the current checkout tip.
