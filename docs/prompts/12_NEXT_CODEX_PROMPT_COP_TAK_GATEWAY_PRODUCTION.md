# Prompt pro COP: produkční napojení TAK Gateway

V SIM je připravená a nasazená služba `tak-gateway-api` pro příjem Cursor-on-Target dat z TAK/ARDOS kompatibilních systémů. COP ji má připojit jako samostatný server-side zdroj partnerských neveřejných dat.

## Produkční endpoint

```text
COP_TAK_GATEWAY_ENABLED=false
COP_TAK_GATEWAY_BASE_URL=https://sim.zeleznalady.cz/tak-gateway/api/v1
COP_TAK_GATEWAY_READ_TOKEN=<tajný token ze SIM .env>
COP_TAK_GATEWAY_CACHE_TTL_MS=5000
COP_TAK_GATEWAY_STALE_IF_ERROR_MS=60000
```

Token nesmí být v browser bundle ani ve frontend env. COP má volat SIM pouze ze server-side source/proxy.

## Read API

```text
GET /cop/features?bbox=west,south,east,north&layers=mobile,ground,traffic&limit=250
Authorization: Bearer <COP_TAK_GATEWAY_READ_TOKEN>
```

Bez tokenu má SIM v produkčním režimu vracet `401 UNAUTHORIZED`. To je očekávané chování, ne chyba.

Validace:

- neplatný `bbox` vrací `400 VALIDATION_ERROR`
- neplatné `layers` vrací `400 VALIDATION_ERROR`
- chybějící nebo špatný token vrací `401 UNAUTHORIZED`
- úspěšné čtení vrací `200` a kontrakt `cop-tak-source-v1`

## Kontrakt odpovědi

COP má zpracovat:

- `features[]` jako GeoJSON body
- `sources[]`, očekávaný zdroj `tak_gateway`
- `summary.featureCount`
- `summary.sourceCount`
- `summary.warningCount`
- `summary.staleFeatureCount`
- `warnings[]`

Feature metadata:

- `properties.label` použij jako primární popisek
- `properties.affiliation` zobraz jen jako situační metadata
- `properties.stale=true` zobraz degradovaně, nepoužívej jako jistou aktuální polohu
- `properties.layer=traffic` zobraz jako `TAK Gateway > Traffic tracks`, nemíchat s veřejnou dopravou

Raw CoT data neočekávej. SIM je defaultně nevystavuje.

## Vrstvy v COP

Přidej zdroj do stromu vrstev jako partnerská/neveřejná data:

```text
TAK Gateway
- Mobile units
- Ground markers
- Traffic tracks
```

Defaultně zdroj vypnout. Zapnout jen pro oprávněné uživatele nebo interní provozní roli.

## Health a dohled

COP může sledovat:

```text
GET https://sim.zeleznalady.cz/tak-gateway/health/ready
GET https://sim.zeleznalady.cz/tak-gateway/api/v1/sources
GET https://sim.zeleznalady.cz/tak-gateway/api/v1/layers
```

`/api/v1/events` nepoužívat pro běžnou mapu. Je to interní/debug endpoint chráněný tokenem.

## Implementační doporučení

1. Přidej samostatný source `tak_gateway`.
2. Source provozuj jen na backendu COP.
3. Přidej krátkou cache `COP_TAK_GATEWAY_CACHE_TTL_MS=5000`.
4. Při výpadku SIM drž poslední odpověď maximálně `COP_TAK_GATEWAY_STALE_IF_ERROR_MS=60000`.
5. `warnings[]` a `stale=true` propaguj do UI jako sníženou kvalitu dat.
6. Nevyvozuj z `affiliation` žádný targeting/workflow, pouze situační zobrazení.
7. Loguj `401` jako konfigurační problém tokenu, ne jako dostupnostní výpadek SIM.

Autoritativní kontrakt v SIM:

- `docs/integration/13_TAK_GATEWAY_CONTRACT.md`
- `docs/api/openapi-tak-gateway.yaml`
