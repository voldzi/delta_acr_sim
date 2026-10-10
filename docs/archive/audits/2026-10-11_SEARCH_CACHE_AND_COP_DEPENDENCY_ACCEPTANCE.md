# Search cache and COP dependency acceptance — 2026-10-11

All runtime times below are UTC on 2026-10-10. This is scoped service and
contract evidence, not nationwide source completeness or real-user acceptance.

## Deployed identity and boundary

- SDA revision: `20a0d961ba4cdb1f100998d7f8e07787dad03327`, built from the
  previously deployed routing revision `9592372a3cdccce835435a653cc1a44304cbf8a9`.
- Image: `sim-situation-data-api:search-boundary-20a0d961ba4c`.
- Image ID: `sha256:60d66a8083e4df55ea5eb8d8713c1846556a96162cd4fce1b70600ffecf89fc4`.
- Only `situation-data-api` was recreated. Environment values, effective mounts,
  ports, resources, security settings, NetworkIDs and stable aliases were
  checked unchanged. All other running container IDs remained unchanged.
- The authoritative image pin is `DRIVER_MEASUREMENTS_IMAGE` in the production
  environment file, used with the existing base, X5 and driver-measurements
  Compose files. No secrets, networks or provider intervals were changed.
- All 82 source/compiled modules were compared against the retained old image.
  Only `search-data` and `response-cache`, in source and compiled form, differed.
  Routing, TPEG2, closure and graph-rebind code were identical.
- The same narrow search change is mirrored in the operator checkout at
  `8f70af7`. That checkout is not itself a replacement for the reviewed routing
  deployment base; rebuilding SDA from it without reconciling routing branches
  would be unsafe.

Two initial attempts rolled back because the declarative
`HostConfig.Mounts` array order varied. The final guard sorts only complete
entries after validating unique canonical targets; it still compares actual
Docker `.Mounts` exactly, including nested mounts, and all other HostConfig
fields exactly. No mount configuration was changed or omitted from comparison.

## Behavior and tests

The Safety search bridge now has a 4500ms total header/body budget, or a shorter
configured timeout. Sanitized source-failure markers preserve incompleteness.
Partial feeds expire within 30s without stale-on-error extension; complete
feeds retain their configured TTL. This is not a universal deadline guarantee
for every source or a new timestamp for old observations.

- Exact production candidate: 318 SDA tests passed, 6 skipped; build,
  typecheck, OpenAPI validation/build check and skeleton validation passed.
- Independent targeted review: 35 tests passed; delayed headers followed by a
  stalled body stopped at approximately 4510ms rather than restarting the budget.
- Operator checkout after mirroring: 35 targeted tests, SDA typecheck/build,
  OpenAPI validation/build check and skeleton validation passed.
- Chroma reindex was attempted using the native repository identity, but its
  server was unreachable. No identity, index or transport configuration changed.

## Ordinary COP acceptance

No cache busting, forced provider refresh, model inference or user content was
used in these requests.

- SIM owner's ordinary COP index request at 23:12:34: HTTP 200, 297ms,
  1000 returned of 3180 collected, next cursor present, zero warnings.
  Whole-collection stale count was 310; the gateway correctly identified its
  normal stale-while-revalidate response as `X-SIM-Gateway-Cache: STALE`.
- COP's independent adapter request: 379ms, `sim-search-source-v1`,
  1000 results, zero stale returned results, zero warnings, next cursor and
  `ONLINE` source health.
- COP's ordinary `safety_alert,fire_incident` query with `includeStale=false`:
  3183ms, 100 results, zero stale returned results and zero warnings. These
  page counts do not assert national coverage.
- Public candidate/news paths remained blocked with 403; private scenarios
  required authentication with 401. Existing trusted internal Safety read
  semantics and binding OpenAPI authentication were preserved.
- Safety image `sha256:10615c34f3452e18a8b0da43e1becde7b5e368d292bcbf3f038b6e994064c46d`
  remained healthy and was not redeployed during this search fix.

## Routing and cold-start boundary

Restart clears RAM-only TEC content and mechanical graph bindings, while the
persisted request-quota gate survives. Early normal requests therefore failed
closed with `ROUTING_KNOWN_CLOSURES_REVIEW_REQUIRED`; the generic error alone
does not prove a geometry defect. No review file or guard was changed.

After the TEC gate naturally permitted fetching and the failed-probe pause
elapsed, the ordinary synthetic car request at 23:17:38.882 passed:
HTTP 200 in 1340ms, one positive-length/time Valhalla route,
`sim-routing-2026-10-10-1791668067`, and one applied approved closure.
Traffic was `warming` with matching dataset. This sample does not claim fresh
traffic acceptance or ETA accuracy; the separate prior fresh-speed/expiry
acceptance remains in the 2026-10-10 Valhalla report.

The subsequent read-only authenticated status at 23:19:40.763 returned 200,
`current` on the same graph, with 1721 applied flows and 13842 applied edges;
`usableUntil=2026-10-10T23:20:56.000000Z`. This is one overlay-status observation,
not measurement of ETA accuracy or permission to reuse expired speeds.

Measurement intake remained `DRIVER_MEASUREMENTS_ENABLED=false` and fixed
`shadow_only`. No Jízda, BYOK or full-chat activation occurred.

## Rollback and outstanding security follow-up

Retained image:
`sim-situation-data-api:known-closures-9592372a3cdccce835435a653cc1a44304cbf8a9`,
ID `sha256:a170158e385ebba35d14097f2bb59f681160c09e4954422c51e0a050bff00bad`.
Sanitized release metadata:
`/srv/sim/.deploy-search-backups/2026-10-10T23-11-44.068Z-20a0d961ba4c`.
To return, change only the SDA image pin, preserve all other environment bytes,
and recreate only `situation-data-api` using all three authoritative Compose
files with `--no-deps --no-build`. Verify health, image, private networks,
effective mounts, flags, search and the naturally warmed closure route.

An earlier failed diagnostic at approximately 22:58 accidentally included
secret-bearing container configuration in automatic session output. The user
and COP owner were informed. No secret values were added to Git or stored in
release proofs. Coordinated rotation requires separate explicit approval;
measurement identity/HMAC history and revocation must not be broken by blind
rotation. This security follow-up remains open and is not resolved by this
service release.
