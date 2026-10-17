# ADR 0041 — New isolated clean lifecycle, not CF24 extension

Status: proposed; executable source + isolated PostgreSQL component tests only.

Use a new schema/config/epoch and contract for fresh owner/resource bindings,
persistent pending jobs and database write fences. Do not infer ownership from
legacy rows or carry an old operation across protocols. Actual AI/driver cleanup
and transaction/restart tests replace an in-memory-only model as component proof.
Do not imply whole-service or production acceptance from these tests.

See [contract 24](../integration/24_CLEAN_LIFECYCLE_SOURCE_CANDIDATE.md) for exact
scope, counts, preservation rules, test evidence and unfulfilled runtime gates.
