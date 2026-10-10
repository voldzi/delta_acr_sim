# ADR 0032: read-only Valhalla operational monitor in SIM

Status: accepted; host monitor installed, full API/UI acceptance pending;
minimal API report-reader guard prepared, not yet claimed deployed.
Date: 2026-10-10.

## Context

Valhalla reachability is not routing readiness. The active graph can exceed the
accepted routing age while Situation Data health still reports `routing:ok`.
A failed weekly build or inactive update timer must reach the SIM operator
before the graph reaches the current 10-day fail-closed routing threshold.

The existing five-minute host monitor writes a report outside the actual
simulator-api `/data` bind after the X5 migration. The API already supports a
generic operational-check alert, but a missing report is not a healthy report.
Only local syslog delivery was initially established; it is not a human push.
The operator chose SIM UI-only notifications. A stopped monitor must not leave
a stale successful report silently green in that UI.

## Decision

- Extend the host operational monitor and its installation/configuration.
  Do not redeploy Situation Data API, UI or routing code. Independently harden
  only the existing main API report reader as specified below.
- Keep tested monitor files in the isolated
  `/home/voldzi/sim-owned-deploy/valhalla-monitor-20261010/scripts/` directory.
  Do not overwrite the runtime checkout. The cron runner uses a pre-redirection
  X5 guard, `flock` and a 240-second timeout; `SIM_OPERATIONAL_ROOT` points at
  `/srv/sim` for the application runtime and existing smoke dependencies.
- Poll every five minutes. Active maps aged >=8 days raise a warning; >=9 days
  are critical. A failed latest weekly attempt or inactive weekly timer is
  critical at the next poll. A build running for more than six hours is critical.
  Unreachable/unparseable status is an explicit monitoring failure, never `ok`.
- Do not relax the 10-day route guard, modify closure review, renew traffic
  leases, run route probes, start builds or change live speeds from this poll.
- Generate a dedicated SSH key on `docker.home.cz`. Keep its private part only
  in protected production secrets, not Git, X5, reports or images. Force its
  public key on Valhalla to the existing maintenance wrapper's fixed `status`,
  with shell/mutations/PTY/forwarding prohibited and host-key verification.
- Separate host-only `monitor.env` (mode 600) accepts only monitor enabled/key,
  report/state paths and alert-reminder interval. `--monitor-env-file` must not
  override API tokens, webhook URLs or arbitrary environment keys. Preserve
  the original `/srv/sim/.env` and credentials unchanged.
- Bound execution and output; publish only sanitized status metadata. No raw
  source payload, GPS, personal identity, key or credential-bearing URL enters
  the report or logs.
- Publish the report atomically to the actual API bind path under
  `/srv/x5-production/data/csm-sim/sim-data/operational-checks/`. Before every X5
  write, verify a separate mount and UUID
  `2f93f595-b61b-4eea-9054-7afa9b275b5b`. Keep deduplication state at the backed-up
  host path `/srv/sim/data/operational-checks/state.json`.
- Reuse the protected existing SIM operations summary and generic
  `operational_check_failed` critical alert. Preserve monitor-level distinction
  between warning and critical, without inventing a dedicated UI alert contract.
- Treat a configured missing, invalid or oversized report as that same existing
  critical alert. Also reject reports older than 15 minutes or more than 30
  seconds in the future. Bound reading to 128 KiB; expose only fixed sanitized
  errors, never failed content, paths or exception details. Add no public
  endpoint, response property or schema change.
- Deploy that reader change, after exact source-file comparison, only in a
  derived image from the immutable current main API image. Copy only reviewed
  `operations-summary.ts` and its compiled module; preserve all other code,
  libraries, flags, Situation Data API and network. Record old/new image
  identities and a guarded rollback manifest; restart only `sim-api`.
- Deduplicate unchanged failures and emit recovery separately. Notifications
  are explicitly **SIM UI only**; create no new Codex heartbeat, e-mail or push.
  An optional webhook remains disabled and needs separate explicit approval and
  acceptance. Syslog success does not prove human delivery.
  A 86400-second reminder is not itself a delivery channel; report
  `userNotificationDelivered` separately from syslog/local `sent`.
- Leave routing, production network, service tokens and Jízda collection flags
  unchanged. Restoring map updates cannot automatically enable measurements.

## Acceptance and consequences

Tests must cover threshold boundaries, failed attempt, inactive timer, stuck
build, bad timestamps/status, transport failure, stable failure deduplication,
recovery, X5 fail-closed publication and missing/invalid/oversized/stale/future
report reading. Use isolated fixtures for mutation
denial, not mutating probes against the running server.

Record tested source revision, installed monitor hash, real scheduler and
restricted identity. Prove a complete report is visible to the existing API and
the authenticated SIM UI. Verify that stopping report updates cannot leave a
green state. Publication alone is not UI acceptance; no external delivery is
part of this chosen mode. Other existing read-model/SLO failures
must remain visible.

Rollback restores only monitor files/configuration and revokes only its newly
dedicated SSH identity if necessary. Preserve unrelated cron jobs, data,
application images and routing/measurement state. The separate reader rollback
returns only `sim-api` to its recorded immutable original image; explicitly
acknowledge that the old image again lacks missing/stale report protection.
Details live in
[Operational Alerting](../runbooks/14_OPERATIONAL_ALERTING.md).
