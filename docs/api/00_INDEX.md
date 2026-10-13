# API dokumentace

Provider model a pravidla pro COM integraci jsou v [../provider/00_INDEX.md](../provider/00_INDEX.md).
Kanonický machine-readable OpenAPI kontrakt je JSON-first:

```text
openapi/openapi.json
```

Historické service-local YAML snapshoty jsou archivované v
[../archive/openapi-yaml/](../archive/openapi-yaml/).

## Dobrovolná měření

Chráněné vyhodnocení dobrovolných měření je v
[kontraktu Jízdy](../integration/20_JIZDA_DRIVER_MEASUREMENTS_CONTRACT.md).
Interní COP-only endpoint a operátorský endpoint SIM jsou dvě oddělené auth
hranice. Nové JSON fragmenty jsou zdrojem pro `openapi/openapi.json`; veřejný
provider katalog ani veřejný operations summary tím nevystavují měření.

## Schemas

- [schemas/00_INDEX.md](schemas/00_INDEX.md)
- [schemas/scenario.schema.json](schemas/scenario.schema.json)
- [schemas/scenario-block.schema.json](schemas/scenario-block.schema.json)
- [schemas/fault-injection.schema.json](schemas/fault-injection.schema.json)
- [schemas/publisher-config.schema.json](schemas/publisher-config.schema.json)
- [schemas/simulator-event.schema.json](schemas/simulator-event.schema.json)
- [schemas/canonical-event-envelope.schema.json](schemas/canonical-event-envelope.schema.json)
- [schemas/ai-scenario-draft.schema.json](schemas/ai-scenario-draft.schema.json)
