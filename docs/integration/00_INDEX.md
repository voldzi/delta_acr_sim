# Integrační dokumentace

Tento adresář drží runtime integraci SIM publisheru a kompatibilní kontrakty starších backend adaptérů.

Nová veřejná dokumentace pro mapové providery je v [../provider/00_INDEX.md](../provider/00_INDEX.md). Pro nové klienty a nové poskytovatele nepoužívej historické `/cop/*` endpointy jako veřejné API; COM klient má volat source-neutral `/api/v1/map/catalog` a `/api/v1/map/query`.

## Runtime publisher a společné zásady

- [01_SHARED_INTEGRATION_CONTRACT.md](01_SHARED_INTEGRATION_CONTRACT.md)
- [02_SIMULATOR_TO_COP_CONTRACT.md](02_SIMULATOR_TO_COP_CONTRACT.md)
- [03_PUBLISHER_CONTRACT.md](03_PUBLISHER_CONTRACT.md)
- [04_RETRY_AND_BACKOFF.md](04_RETRY_AND_BACKOFF.md)
- [05_ERROR_MODEL.md](05_ERROR_MODEL.md)
- [06_VERSIONING_POLICY.md](06_VERSIONING_POLICY.md)
- [07_DRY_RUN_MODE.md](07_DRY_RUN_MODE.md)

## Kompatibilní provider kontrakty

- [08_FLIGHT_DATA_SOURCE_CONTRACT.md](08_FLIGHT_DATA_SOURCE_CONTRACT.md)
- [09_SITUATION_DATA_SOURCE_CONTRACT.md](09_SITUATION_DATA_SOURCE_CONTRACT.md)
- [10_SAFETY_DATA_SOURCE_CONTRACT.md](10_SAFETY_DATA_SOURCE_CONTRACT.md)
- [11_ARDOS_PARTNER_DATA_CONTRACT.md](11_ARDOS_PARTNER_DATA_CONTRACT.md)
- [13_TAK_GATEWAY_CONTRACT.md](13_TAK_GATEWAY_CONTRACT.md)
- [14_CSM_NOTIFICATION_INPUT_CONTRACT.md](14_CSM_NOTIFICATION_INPUT_CONTRACT.md)
- [15_COP_WEATHER_RADAR_PRESENTATION_INSTRUCTIONS.md](15_COP_WEATHER_RADAR_PRESENTATION_INSTRUCTIONS.md)
- [16_PUBLIC_TRANSIT_CONTEXT_CONTRACT.md](16_PUBLIC_TRANSIT_CONTEXT_CONTRACT.md)
