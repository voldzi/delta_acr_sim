# Prompt pro COP: TAK Gateway source

V projektu SIM byla přidána samostatná služba `tak-gateway-api`. Služba přijímá Cursor-on-Target XML z TAK/ARDOS kompatibilních systémů a publikuje data pro COP jako GeoJSON kontrakt `cop-tak-source-v1`.

## Endpointy

Veřejný read endpoint pro COP:

```text
GET https://sim.zeleznalady.cz/tak-gateway/api/v1/cop/features?bbox=west,south,east,north&layers=mobile,ground,traffic&limit=250
```

Pro reálná ARDOS data bude SIM nastavená s `TAK_GATEWAY_PUBLIC_READ=false`. COP musí endpoint číst server-side s hlavičkou:

```http
Authorization: Bearer <TAK_GATEWAY_READ_TOKEN>
```

Metadata:

```text
GET https://sim.zeleznalady.cz/tak-gateway/api/v1/layers
GET https://sim.zeleznalady.cz/tak-gateway/api/v1/sources
GET https://sim.zeleznalady.cz/tak-gateway/api/v1/config
GET https://sim.zeleznalady.cz/tak-gateway/health/ready
GET https://sim.zeleznalady.cz/tak-gateway/metrics
```

Ingest endpoint není pro COP:

```text
POST https://sim.zeleznalady.cz/tak-gateway/api/v1/cot/events
Authorization: Bearer <TAK_GATEWAY_INGEST_TOKEN>
Content-Type: application/xml
```

## Implementace v COP

1. Přidej nový volitelný zdroj `tak_gateway`.
2. Source klient má číst jen `GET /tak-gateway/api/v1/cop/features`.
3. Zobraz vrstvy `mobile`, `ground`, `traffic`; defaultně zapni jen `mobile` v interním režimu.
4. Použij `properties.label` jako hlavní label, `properties.affiliation` jen jako situační metadata.
5. `properties.stale=true` zobraz viditelně degradovaně a nepoužívej jako aktuální polohu.
6. Raw CoT neočekávej; SIM ho defaultně nevystavuje.
7. TAK/ARDOS vrstva musí být dostupná jen oprávněným uživatelům, protože nejde o veřejná open data.
8. Token pro čtení nevkládej do browser bundle; použij backend/proxy COP.

## Dokumentace SIM

- `docs/integration/13_TAK_GATEWAY_CONTRACT.md`
- `docs/api/openapi-tak-gateway.yaml`
- `docs/tak-gateway/00_INDEX.md`
