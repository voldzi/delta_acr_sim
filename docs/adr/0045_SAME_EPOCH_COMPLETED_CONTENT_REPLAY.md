# ADR 0045 — Explicit same-epoch completed-content replay

Status: source candidate and owned isolated tests; production not enabled.

The original worker selected pending jobs only. A content-only restore with an
already-completed target journal therefore remained fenced but could not be
cleaned again. SQL-only capability or a historical receipt cannot prove zero
content after a restore.

Add the explicit internal worker mode
`same-epoch-completed-content-replay-v1`. It is disabled by default and never
accepts CF24 operations, new identities, another epoch, or an unknown restore
generation. It does not enroll, reset or alter independent authority/checkpoints.
Production-mode UserLedger still requires actual independent admission for every
transaction. All INSERT/UPDATE fences and immutable jobs remain unchanged.

Pending jobs have priority. An opted-in idle worker walks already-deleted owners
in bounded round-robin order, retaining the exact account/job lock ordering.
It invokes actual existing cleanup and fresh zero verification, without changing
terminal account/job fields. A restored unsettled reservation, foreign payer,
unknown file or seal mismatch is an error, never a new completion. Runtime roles
gain no DDL or broader access. Two additive migration files permit only DELETE
under an already-deleted owner with a completed original job in the same epoch.

Anonymous finance was already committed with the original cleanup. Terminal
replay must not add the restored rows to totals again. It deletes restored
content while preserving existing financial totals. This assumes content-only
restore with current authority/journals/finance retained; an old full target or
unknown generation stays subject to the independent restore/quarantine process.

Clean status and idempotent request perform a fresh residual check before
returning deleted. SIM main/history already did so and retain that behavior.
Receipt wire versions and authentication are unchanged. There is no replay HTTP
endpoint, force-complete flag, administrative bypass or new Root protocol.

Evidence: 43 actual local PostgreSQL/HTTP checks with pg_dump/pg_restore, nonzero
restored AI/driver/SIM-history content, actual compiled history cleanup and fresh
HTTP 503→200/zero, B preservation, immutable jobs and unchanged finance. A
separate 84-check actual main/Router/relay test restores four main files, observes
503 and removes them through actual main.tick; B and the original job persist.
The original 158 PostgreSQL checks (two restarts) still pass. These are component
tests, not actual Keycloak deletion, whole12 restore or production acceptance.

Deployment requires new immutable runtime image pins, reviewed additive SQL,
explicit worker-mode configuration and a coordinated stopped-writer restore test.
Do not mutate the running whole12 A operation or its private identity to install
this candidate. Old manifests and authority source hashes are left untouched.
Rollback: disable this worker mode, retain fences/journals and quarantine residual
restored content. Do not restore deleted user data or claim the old image can
complete replay; residuals must continue returning 503.
