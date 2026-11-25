# Valhalla refresh acceptance — 2026-11-25

## Cause and scoped repair

The 2026-11-22 weekly run failed in downloading with `Unexpected CZ Geofabrik
redirect target`. The official source had moved to a country subdirectory. No
build was active when repair began; approximately 45 GiB was available. This was
not the earlier capacity failure. The exact same-origin country-directory
allowlist repair is published in commit `0543098` on
`codex/crisis-sources-notifications`.

- Installed updater SHA-256:
  `3adcebaac5ed9fbf90c1b5dcfa855552a89a5b30a50a8976449a182d37de43bd`.
- Previous updater retained as `weekly-update.sh.before-layout-20261125`.
- One normal run: `20261125T145842Z`, started 14:58:42 UTC, activated
  18:25:35 UTC (19:25:35 Europe/Prague), finished successfully at 18:25:37 UTC.
- Active symlink and last-success agree on that release. Previous release:
  `20261115T012951Z`. Graph dataset:
  `sim-routing-2026-11-25-1795631051`.
- Candidate/live locate, isochrone, six country route checks and height passed.
  Host healthcheck subsequently succeeded; free disk approximately 41 GiB.
- HTTPS, checksums, build reserve, rollback, graph-age/auth/closure guards,
  provider limits and experimental-fallback prohibition were not relaxed.

## Actual SIM requests and independent COP acceptance

Ordinary synthetic car requests through the deployed SIM API returned:

| Request | HTTP | Dataset | Result |
| --- | --- | --- | --- |
| Prague public anchors | 200 | new exact dataset above | 5,263 m / 900 s; closures applied |
| Prague–Brno public anchors | 200 | same | 210,241 m / 8,484 s; closures applied |
| Brno–Vienna centre anchor | 422 | no successful route | `ROUTING_LOCATION_NOT_ROUTABLE` |

The last result remains an explicit limitation, not a passed SIM route, despite
native Valhalla's AT validation succeeding. No snapping/access protection was
changed to make that anchor pass.

COP independently reported successful production requests through its running
RoutingSourceAdapter for Prague (3,083 m), Brno (2,087 m), and Prague–Brno
(209,707 m), all covered on the same new dataset. These are COP-owned observations,
not physical iPhone acceptance. Different public anchors may return 422.

## Fresh traffic acceptance

At 19:49:12.649 UTC, an ordinary SIM car request with `includeTraffic=true`
returned HTTP 200 in 175 ms, route status `ok`, and the new dataset. Its
`traffic.liveSpeeds` metadata confirmed:

- `state=current`, exact new routing dataset;
- 6,598 applied flow records / 55,582 applied directed edges;
- source observation 19:46:02 UTC, update 19:49:05.512251 UTC;
- `usableUntil=2026-11-25T19:51:44Z`, later than response time;
- 35,668 mapped segments, mapping coverage 64.67%.

New-graph mapping was created through the existing normal vehicle lease. Old
graph/selection edges were not copied, no updater/provider refresh was forced,
and no paid fallback was enabled. During warm-up the old graph report had zero
applied counts and was not accepted as current. Mapping coverage is not ETA
accuracy; no ETA accuracy percentage or per-trip prediction quality is claimed.

## Recurring operation and evidence limits

The existing weekly timer remains active, next observed run
2026-11-29 01:27:05 UTC. The five-minute SIM operational cron and a fresh X5
report were inspected: at 19:05 UTC `valhallaUpdates=ok`, failures empty, exact
new dataset. The configured monitor warns at eight days, is critical at nine
days, and immediately reports update failure, before the routing ten-day hard
stop. No new persistent agent timer was created; temporary waits ended.

Local verification: four redirect-security test methods (including all six
countries and negative URL cases), 25 monitor tests, 21 report/publication tests,
shell syntax, skeleton validation and diff whitespace checks passed. The next
scheduled run is not yet observed; its future success is not claimed.
