# OpenAPI

The binding machine-readable API contract for CSM SIM is:

```text
openapi/openapi.json
```

It is a composite OpenAPI 3.1 document for the simulator runtime, flight data,
situation data, safety data, and TAK gateway API surfaces.

## Validation

```bash
pnpm openapi:validate
pnpm openapi:lint
```

`openapi:validate` runs deterministic JSON and structural checks. `openapi:lint`
runs Redocly linting.

## Regeneration

During the migration from service-local YAML snapshots, the composite JSON can
be regenerated with:

```bash
pnpm openapi:build
```

The historical YAML snapshots are archived in:

```text
docs/archive/openapi-yaml/
```

New API behavior should update `openapi/openapi.json` as the binding artifact.
