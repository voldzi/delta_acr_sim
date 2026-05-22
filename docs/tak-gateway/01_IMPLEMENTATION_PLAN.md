# TAK Gateway Implementation Plan

## Cíl

SIM bude adapter/cache mezi TAK/ARDOS světem a COM. COM neparsuje CoT XML a nenapojuje se přímo na TAK server. COM čte pouze stabilní SIM endpoint:

```text
GET /tak-gateway/api/v1/features
```

## Implementovaný rozsah

1. Samostatná služba `@delta-acr/tak-gateway-api` na portu `4040`.
2. Chráněný ingest endpoint `POST /api/v1/cot/events` s bearer tokenem `TAK_GATEWAY_INGEST_TOKEN`.
3. Chráněný read endpoint přes `TAK_GATEWAY_PUBLIC_READ=false` a `TAK_GATEWAY_READ_TOKEN`; veřejné čtení je jen explicitní syntetický pilotní režim.
4. In-memory stav posledních CoT eventů podle `uid`, bounded retention a `maxEvents`.
5. Normalizace CoT point eventů do GeoJSON kontraktu `cop-tak-source-v1`.
6. Health, metrics, source registry, layer registry a public config endpointy.
7. Docker Compose service a nginx proxy pod `/tak-gateway/*`.

## Bezpečnostní hranice

- TAK/ARDOS data nejsou veřejná open data.
- Raw CoT se defaultně nepublikuje (`TAK_GATEWAY_EXPOSE_RAW=false`).
- Ingest token musí být pro pilot změněn mimo repozitář.
- COM musí rozhodovat viditelnost vrstvy podle role uživatele.
- SIM ani COM nesmí nad daty implementovat targeting, navádění nebo zbraňové workflow.

## Další kroky

1. Doplnit reálný ARDOS/TAK bridge klient podle konkrétního transportu, který ARDOS poskytne.
2. Přidat per-partner rate limit a audit log ingest requestů.
3. Po dohodě s COM doplnit interní oprávnění pro neveřejnou vrstvu.
4. Pokud bude potřeba dlouhodobá historie, přesunout event store z paměti do PostGIS/TimescaleDB.
