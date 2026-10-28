# ADR 0049: bounded private routing diagnostics

Status: source candidate; not deployed or activated.

An actual mapped-car request remains rejected with typed 422 even with a single
variant and an explicitly selected planning start. Neither an endpoint cause
nor a legal-access violation has been established. Valhalla 3.8.3 warning 401
identifies multipass search, not the specific edge, algorithm change or legal
restriction that caused it. Existing fail-closed routing stays unchanged.

COP may forward a validated request-scoped UUID in the existing correlation
header. SIM passes this as separate internal context, never as routing body,
costing option or cache/single-flight key. A short explicit UTC expiry and fixed
sixteen-error budget bound private diagnostic events. Default is off. Every
field is allowlisted and bounded; no coordinates, vehicle/account values or
identifiers, provider prose, authorization data or extra caller fields are
logged. Algorithm/multipass cause remain explicitly unknown when the engine
does not report them. Public errors do not gain diagnostic metadata.

Single-flight computation and independent result clones are preserved. Safe
native facts are constructed from outgoing mode/counts and returned warning
codes, then carried alongside the cloned result in a private wrapper; caller
IDs never enter it. An error is logged per caller with its own validated UUID.
Logging failure cannot alter routing or retry behavior. No automatic replay,
additional engine/provider query, snap widening, profile drop, permission
relaxation, new arrival/origin contract or navigation start is introduced.

Activation is a separate Root-reviewed situation-data deployment preserving all
current guards and lifecycle configuration, coordinated COP correlation and a
fresh ten-minute-or-shorter expiry. One human-authorized request supplies the
evidence; do not manufacture it from old payloads. Existing log retention/access
must be checked: expiry stops new events, not deletion of existing logs.
Unknown actual engine cause remains unknown and requires separately reviewed
isolated instrumentation, not an acceptance waiver. Reverse uses the prior
pinned image/config without restoring data. Exact event/limits and acceptance
boundaries are in runbook 13 and testing 06.
