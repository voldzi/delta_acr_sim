# ADR 0042 — Explicit Root-enrolled clean production mode

Status: source + owned synthetic PostgreSQL/HTTP tests. No live activation.

The human's direct COP approval for a reset of test user data was independently
read before preparing this mode. It does not authorize deletion of other lanes,
configuration, provider data or implicit activation from this SIM change.

Add `production-clean-lifecycle-v1` as a separate exact server-side mode. It must
match the database mode. Never promote an isolated namespace, carry old jobs
across contracts or generate missing epoch metadata at startup.

An owner-only, security-invoker enrollment function locks and checks the finite
COP user scope, then atomically creates an immutable enrollment and configuration.
It does not delete data. Non-COP request and IZS billing history remains intact.
Runtime must match environment, epoch, dataset UUID, enrollment UUID and nonzero
token cutoff, and pass the same limited-role, privilege, trigger/view checks.

Root separately owns reset execution and the independent journal, quarantine and
same-epoch restore/replay acceptance. This enrollment is not a backup-restore
detector or whole-account completion proof. See integration contract 24.
