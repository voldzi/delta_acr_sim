# TAK Gateway Contract

TAK Gateway je neveřejný partnerský zdroj pro COP. Přijímá Cursor-on-Target XML z TAK/ARDOS kompatibilních systémů a publikuje poslední známý stav jako GeoJSON. COP nevolá TAK přímo.

## COP read endpoint

```http
GET /tak-gateway/api/v1/cop/features?bbox=west,south,east,north&layers=mobile,ground,traffic&limit=250
```

Veřejná URL pilotu:

```text
https://sim.zeleznalady.cz/tak-gateway/api/v1/cop/features
```

Pro reálná partnerská data nastav v SIM `TAK_GATEWAY_PUBLIC_READ=false` a `TAK_GATEWAY_READ_TOKEN`. COP potom volá endpoint server-side s hlavičkou:

```http
Authorization: Bearer <TAK_GATEWAY_READ_TOKEN>
```

Query parametry a validace:

| Parametr | Popis |
| --- | --- |
| `bbox` | WGS84 `west,south,east,north`. Pokud chybí, použije se default ČR. |
| `layers` | `mobile`, `ground`, `traffic`; výchozí jsou všechny. |
| `limit` | 1-1000, výchozí 250. |
| `includeRaw` | Raw CoT se vrátí jen pokud je zároveň `TAK_GATEWAY_EXPOSE_RAW=true`. |

Chybný `bbox`, prázdný výběr vrstev nebo neznámé vrstvy vrací `400 VALIDATION_ERROR`. Pokud je `TAK_GATEWAY_PUBLIC_READ=false`, chybějící nebo chybný bearer token vrací `401 UNAUTHORIZED`.

Vrstva `traffic` v tomto kontraktu znamená `TAK Gateway > Traffic tracks`, tedy transportní/air/vehicle tracky z CoT. Není to veřejná dopravní vrstva z `situation-data`.

## Response

```json
{
  "contractVersion": "cop-tak-source-v1",
  "type": "FeatureCollection",
  "generatedAt": "2026-05-21T06:00:00.000Z",
  "source": {
    "sourceId": "tak-gateway-api",
    "sourceType": "TAK_COT_GATEWAY",
    "generatedAt": "2026-05-21T06:00:00.000Z"
  },
  "query": {
    "bbox": { "west": 13.5, "south": 49.5, "east": 15.5, "north": 50.6 },
    "layers": ["mobile"],
    "limit": 250
  },
  "summary": {
    "eventCount": 1,
    "featureCount": 1,
    "sourceCount": 1,
    "staleFeatureCount": 0,
    "warningCount": 0,
    "affiliationCounts": { "friend": 1, "hostile": 0, "neutral": 0, "unknown": 0 }
  },
  "features": [
    {
      "type": "Feature",
      "id": "tak:cot:TAK-ARDOS-001",
      "geometry": { "type": "Point", "coordinates": [14.421, 50.087] },
      "properties": {
        "featureId": "tak:cot:TAK-ARDOS-001",
        "layer": "mobile",
        "category": "tak_unit",
        "label": "ARDOS Alpha",
        "sourceId": "tak_gateway",
        "observedAt": "2026-05-21T06:00:00.000Z",
        "receivedAt": "2026-05-21T06:00:02.000Z",
        "validUntil": "2026-05-21T06:10:00.000Z",
        "confidence": 0.95,
        "stale": false,
        "affiliation": "friend",
        "license": {
          "name": "TAK/CoT partner data",
          "attribution": "TAK/ARDOS partner feed"
        },
        "metrics": {
          "ageSeconds": 2,
          "altitudeHaeM": 250,
          "circularErrorM": 15,
          "linearErrorM": 20,
          "courseDeg": 92,
          "speedMps": 4.2
        },
        "tags": {
          "cotType": "a-f-G-U-C",
          "how": "m-g",
          "groupName": "ARDOS",
          "groupRole": "Team Member"
        }
      }
    }
  ],
  "sources": [
    {
      "sourceId": "tak_gateway",
      "label": "TAK/CoT gateway",
      "enabled": true,
      "mode": "live",
      "priority": 20,
      "layers": ["mobile", "ground", "traffic"],
      "license": {
        "name": "TAK/CoT partner data",
        "attribution": "TAK/ARDOS partner feed",
        "commercialUse": "requires_license",
        "operationalUse": "requires_license",
        "notes": [
          "Data is partner-provided, not public open data.",
          "COP must apply user authorization and should not expose raw CoT details to public users.",
          "SIM stores only the latest event state with bounded retention."
        ]
      },
      "updateCadenceSeconds": 15
    }
  ],
  "warnings": []
}
```

## Ingest endpoint

```http
POST /tak-gateway/api/v1/cot/events
Authorization: Bearer <TAK_GATEWAY_INGEST_TOKEN>
Content-Type: application/xml
```

Ukázka vstupu:

```xml
<event version="2.0" uid="TAK-ARDOS-001" type="a-f-G-U-C" time="2026-05-21T06:00:00.000Z" start="2026-05-21T06:00:00.000Z" stale="2026-05-21T06:10:00.000Z" how="m-g">
  <point lat="50.0870" lon="14.4210" hae="250" ce="15" le="20"/>
  <detail>
    <contact callsign="ARDOS Alpha"/>
    <__group name="ARDOS" role="Team Member"/>
    <track course="92" speed="4.2"/>
    <remarks>synthetic integration test</remarks>
  </detail>
</event>
```

Úspěšná odpověď má status `202 Accepted`:

```json
{
  "accepted": true,
  "eventCount": 1,
  "warningCount": 0,
  "warnings": []
}
```

Chyby:

| Status | Code | Kdy |
| --- | --- | --- |
| `400` | `INVALID_COT_XML` | XML payload není CoT, neobsahuje `<event>`, nemá `uid`, `type` nebo platný `point lat/lon`. |
| `401` | `UNAUTHORIZED` | Chybí nebo nesedí `TAK_GATEWAY_INGEST_TOKEN`. |

Error kontrakt:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing or invalid bearer token.",
    "correlationId": "..."
  }
}
```

## Metadata a dohled

```text
GET /tak-gateway/health/live
GET /tak-gateway/health/ready
GET /tak-gateway/metrics
GET /tak-gateway/api/v1/layers
GET /tak-gateway/api/v1/sources
GET /tak-gateway/api/v1/config
```

`GET /tak-gateway/api/v1/events` je pouze interní/debug endpoint. Je vždy chráněný bearer tokenem, i když je `TAK_GATEWAY_PUBLIC_READ=true`. Lze použít `TAK_GATEWAY_READ_TOKEN` nebo `TAK_GATEWAY_INGEST_TOKEN`. Raw CoT vrací jen při `includeRaw=true` a současně `TAK_GATEWAY_EXPOSE_RAW=true`.

## Doporučení pro COP

1. Přidej volitelný zdroj `tak_gateway`.
2. Čti `GET /tak-gateway/api/v1/cop/features` stejně jako jiné GeoJSON mapové zdroje.
3. Vrstvu defaultně zapínej jen v interním nebo partnerském režimu.
4. Zobraz `stale=true` jako degradovaný stav, ne jako aktuální polohu.
5. Nepoužívej `affiliation` k žádnému targeting nebo naváděcímu workflow. Je to pouze situační metadata.
6. Pro reálný pilot čti SIM ze serveru COP s `TAK_GATEWAY_READ_TOKEN`; token nevkládej do frontendového bundle.
