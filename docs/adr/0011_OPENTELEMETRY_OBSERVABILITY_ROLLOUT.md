# ADR 0011: OpenTelemetry Observability Rollout

## Status

Accepted

## Context

CSM SIM currently exposes liveness, readiness, dependency checks, Prometheus
style metrics, and sanitized provider observability summaries. This is enough
for basic operational supervision, but it does not provide distributed tracing
across the simulator API, provider APIs, COP server-side calls, external data
sources, PostGIS, Valkey, and TAK ingest flows.

The central application standard prefers OpenTelemetry for traces, metrics, and
logs. SIM is a server-to-server provider and must not expose raw telemetry or
internal metrics publicly.

## Decision

Adopt OpenTelemetry incrementally without replacing the existing internal
Prometheus metrics.

The target deployment is:

- one `otel-collector` sidecar/service in the SIM docker compose stack,
- OTLP export from Node.js services to `otel-collector:4317` or `:4318`,
- service names:
  - `csm-sim-api`
  - `csm-sim-flight-data-api`
  - `csm-sim-situation-data-api`
  - `csm-sim-safety-data-api`
  - `csm-sim-tak-gateway-api`
- trace propagation using W3C `traceparent` and existing correlation IDs,
- existing `/metrics` endpoints kept internal for Prometheus scraping and
  backwards-compatible operational checks,
- no public proxying of OTLP, collector UI, raw traces, raw logs, or internal
  metrics.

The collector backend is intentionally not fixed by this ADR. The first pilot
can export to logging/debug output or a local tracing backend. Production should
export to the selected monitoring stack, for example Grafana Tempo, Jaeger, or
an existing OpenTelemetry-compatible backend.

## Implementation Plan

1. Add a shared workspace package `packages/observability` that exports
   OpenTelemetry-compatible OTLP traces only when `OTEL_SDK_DISABLED=false` or
   `OTEL_EXPORTER_OTLP_ENDPOINT` is configured. **Implemented.**
2. Instrument Express request handling for all Node APIs with route, method,
   status, `requestId`/`correlationId`, and service name. **Implemented.**
3. Instrument outbound HTTP fetches to public sources and COP with upstream
   name, cache hit/miss/stale status, status code, timeout, and retry outcome.
4. Instrument PostGIS and Valkey operations where they affect provider latency
   or cache behavior.
5. Add `otel-collector` to docker compose behind the internal docker network
   only. Do not publish collector ports through `sim-web` or DMZ nginx.
   **Implemented as opt-in `observability` profile.**
6. Extend `docs/application/09_OBSERVABILITY.md` and deployment docs with
   runbook checks for traces, metrics, collector health, and rollback.
   **Implemented for the first rollout step.**
7. Update CI to keep OpenTelemetry optional: tests must pass when the collector
   is absent.

## Consequences

SIM gains request-level and, in later phases, source-level traceability without
exposing operational internals to public clients.

The existing Prometheus metrics remain useful for dashboards and alerts; traces
are added for root-cause analysis, latency breakdowns, and cross-service
debugging.

OpenTelemetry must be treated as an internal operational channel. Sensitive
payloads, partner data, TAK raw XML, bearer tokens, APNs tokens, personal
location data, and raw external source responses must never be stored in spans
or logs.

The first implementation intentionally uses a lightweight OTLP HTTP exporter
inside `packages/observability` instead of the full OpenTelemetry Node SDK. This
keeps service startup deterministic in the current Node 24 workspace while
preserving OTLP compatibility with `otel-collector`.
