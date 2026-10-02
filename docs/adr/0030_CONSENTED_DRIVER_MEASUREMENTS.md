# ADR 0030: consented driver measurements, shadow-only

Status: accepted for implementation; production intake default disabled.
Date: 2026-10-01.

## Context

Community traffic observations already reach COP, but that is not a continuous
speed ingestion contract. GPS quality, direction, graph identity, stop type,
consent, contributor integrity and replay must be explicit before using Jízda
measurements for routing quality. A client ETA is not independent ground truth.

## Decision

- Add an authenticated COP-only Situation Data API boundary with strict typed
  batches, daily COP-derived pseudonyms and explicit consent attestation.
- Match actual GPS server-side using Valhalla POST map_snap; derive intervals
  from measured elapsed time, not routing engine edge cost/speed. Reject gaps,
  ambiguous/discontinuous edges, estimated points and poor sensor quality.
- Fence results to the graph generation; preserve independent provider paths.
- Persist only derived pseudonymous data in a dedicated PostgreSQL DB behind
  HAProxy, with an application account without DDL. No raw GPS persistence.
- Deduplicate batches, sample pairs and ETA events; use transaction locks
  across submissions and consent revocation. Retain normalized data 7 days.
- Equal-weight per-contributor medians, >=5 attested contributors and >=10
  intervals/ETA observations before aggregate release. These thresholds do
  not prove independent humans or legal anonymization.
- All outputs are shadow_only. No write into the Valhalla traffic archive,
  no single phone overriding TPEG2, no automatic learned ETA correction.
- Raw/derived data do not enter public map layers, AI prompts or historical
  person-track databases. COP governs user identity, consent and minimization.

## Consequences and acceptance

The contract supports coverage diagnostics and client-reported ETA comparisons,
not an accuracy claim. Same-edge intervals omit edge transitions/stationary
waiting; GPS map matching alone cannot guarantee the correct parallel lane.
Five pseudonyms can still be spoofed unless COP enforces contributor integrity.
Runtime-local request limits require load testing before scaled rollout.
Production enablement needs dedicated DB, secrets and joint COP/Jízda acceptance;
live-speed promotion requires a separate directional/ETA canary decision.

Rollback disables the intake and restarts only Situation Data API, leaving
normal routing/provider layers untouched. Data remains subject to retention
and revocation including an operator-managed backup deletion policy.
See [integration contract](../integration/20_JIZDA_DRIVER_MEASUREMENTS_CONTRACT.md).

Amendment 2 Oct 2026: intake rollback must not block retained-data deletion.
The independent default-off `DRIVER_MEASUREMENTS_REVOCATION_ENABLED` allows
only authenticated DELETE and retention cleanup with dedicated credentials;
it does not enable collection, reads, map matching or traffic promotion.
Both flags default false. Storage errors retain pending COP deletion and never
report successful erasure. Keep HMAC/token/database configuration during rollback.

Production amendment 2 Oct 2026: dedicate PostgreSQL via HAProxy and an opt-in
internal Docker bridge shared only with COP API. Persist namespaced HMAC UUIDs,
never raw request IDs; omit measurement HTTP tracing. Run independent retention
cleanup even during API downtime. Restored measurement databases must be purged
in quarantine before reconnecting; physical cluster backup expiry needs separate
backup-owner confirmation. See production runbook 17. Collection remains off.
