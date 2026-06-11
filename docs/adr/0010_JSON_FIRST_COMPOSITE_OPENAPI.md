# ADR 0010: JSON-First Composite OpenAPI

## Status

Accepted

## Context

CSM SIM exposes several REST API surfaces from one monorepo: simulator runtime,
flight data, situation data, safety data, and TAK gateway.

Before this migration, the active API specifications were service-local YAML
files under `docs/api/`. The central standard requires a JSON-first binding
OpenAPI file at `openapi/openapi.json`. It also prefers one OpenAPI document
with tags when a repository has multiple API surfaces.

## Decision

Use `openapi/openapi.json` as the binding composite OpenAPI document for the
repository.

The document uses path prefixes and tags to separate API surfaces. Historical
YAML files are archived under `docs/archive/openapi-yaml/`. During the
transition, `scripts/build-openapi-json.rb` can regenerate the composite JSON
from the archived YAML snapshots.

Existing endpoint paths and response shapes are not changed by this migration.
Current error responses use `correlationId`; unifying to the central
`requestId` error shape is a planned compatibility-safe follow-up.

The TAK CoT ingest endpoint accepts Cursor-on-Target XML. The OpenAPI document
records the existing `application/xml` request body; changing that endpoint to
JSON is out of scope for this migration and would require a compatibility
design.

## Consequences

OpenAPI validation and future client generation have a single binding JSON
artifact.

The archived YAML snapshots are not the source of truth for new API changes.
API changes must update `openapi/openapi.json`; if the transitional generator is
used, its inputs and output must be reviewed together.
