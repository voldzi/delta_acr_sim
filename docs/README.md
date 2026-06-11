# CSM SIM Documentation

This repository keeps the established numbered documentation convention under
`docs/`. The central application standards are mapped to existing canonical
documents instead of duplicating flat files. The decision is recorded in
`docs/adr/0009_KEEP_NUMBERED_DOCUMENTATION_CONVENTION.md`.

## Standards Mapping

| Standard topic | Local canonical document |
| --- | --- |
| README | [`../README.md`](../README.md) |
| Architecture | [`architecture/00_INDEX.md`](architecture/00_INDEX.md) |
| API | [`api/00_INDEX.md`](api/00_INDEX.md) and [`../openapi/openapi.json`](../openapi/openapi.json) |
| Security | [`security/00_INDEX.md`](security/00_INDEX.md) |
| Operations | [`runbooks/00_INDEX.md`](runbooks/00_INDEX.md) and [`../deploy/docker-home.md`](../deploy/docker-home.md) |
| Observability | [`application/09_OBSERVABILITY.md`](application/09_OBSERVABILITY.md) |
| Runbook | [`runbooks/00_INDEX.md`](runbooks/00_INDEX.md) |
| ADRs | [`adr/00_INDEX.md`](adr/00_INDEX.md) |
| Environment | [`../.env.example`](../.env.example) and [`runbooks/03_ENVIRONMENT_CONFIGURATION.md`](runbooks/03_ENVIRONMENT_CONFIGURATION.md) |

## Active Documentation Indexes

- [`00_INDEX.md`](00_INDEX.md)
- [`product/00_INDEX.md`](product/00_INDEX.md)
- [`architecture/00_INDEX.md`](architecture/00_INDEX.md)
- [`application/00_INDEX.md`](application/00_INDEX.md)
- [`simulation/00_INDEX.md`](simulation/00_INDEX.md)
- [`flight-data/00_INDEX.md`](flight-data/00_INDEX.md)
- [`situation-data/00_INDEX.md`](situation-data/00_INDEX.md)
- [`tak-gateway/00_INDEX.md`](tak-gateway/00_INDEX.md)
- [`provider/00_INDEX.md`](provider/00_INDEX.md)
- [`integration/00_INDEX.md`](integration/00_INDEX.md)
- [`api/00_INDEX.md`](api/00_INDEX.md)
- [`ai/00_INDEX.md`](ai/00_INDEX.md)
- [`security/00_INDEX.md`](security/00_INDEX.md)
- [`ui/00_INDEX.md`](ui/00_INDEX.md)
- [`testing/00_INDEX.md`](testing/00_INDEX.md)
- [`runbooks/00_INDEX.md`](runbooks/00_INDEX.md)
- [`adr/00_INDEX.md`](adr/00_INDEX.md)

## Machine-Readable API Contract

The binding API contract is:

```text
openapi/openapi.json
```

Historical YAML OpenAPI snapshots from the pre-migration documentation set are
archived in `docs/archive/openapi-yaml/`.

## Documentation Rules

- Keep active documents current-state.
- Put historical analyses, generated exports, and superseded designs under
  `docs/archive/`.
- Update this mapping when a standard topic moves.
- Record significant architecture, data, storage, security, deployment,
  rollback, or integration decisions in `docs/adr/`.
- Update the matching mapped document when a change affects API,
  configuration, deployment, testing, security, data handling, or operations.
