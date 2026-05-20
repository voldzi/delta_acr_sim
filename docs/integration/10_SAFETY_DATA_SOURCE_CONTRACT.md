# Safety Data source contract

**Status:** Implementováno pro pilot

Safety Data API je samostatný COP zdroj pro veřejná bezpečnostní data. Kontrakt je oddělený od `situation-data`, protože bezpečnostní výstrahy mají jinou závažnost, platnost a auditní požadavky než obecný mapový kontext.

## Autoritativní endpoint pro COP

```text
GET /safety-data/api/v1/cop/features
```

Produkční URL za SIM gateway:

```text
https://sim.zeleznalady.cz/safety-data/api/v1/cop/features
```

Podporované query parametry:

- `bbox=west,south,east,north` ve WGS84.
- `layers=warnings,flood`.
- `source=chmi_alerts,chmi_hydro` nebo `source=mock`.
- `limit=1..1000`.
- `includeRaw=1` pouze pro diagnostiku.

## Kontrakt

Odpověď je GeoJSON `FeatureCollection` s verzí:

```json
{
  "contractVersion": "cop-safety-source-v1",
  "type": "FeatureCollection",
  "source": {
    "sourceId": "safety-data-api",
    "sourceType": "PUBLIC_SAFETY_AGGREGATE"
  },
  "summary": {
    "featureCount": 12,
    "sourceCount": 2,
    "staleFeatureCount": 0,
    "advisoryCount": 1,
    "warningCount": 2,
    "criticalCount": 0
  },
  "features": []
}
```

Každá feature nese:

- `properties.layer`: `warnings` nebo `flood`.
- `properties.severity`: `info`, `advisory`, `warning`, `critical`.
- `properties.urgency` a `properties.certainty`.
- `properties.observedAt`, volitelně `effectiveAt` a `expiresAt`.
- `properties.license` s atribucí původního zdroje.
- `properties.metrics` pro číselné hodnoty, např. hladina, průtok, SPA.
- `properties.tags` pro strojově čitelné doplňky.

## Zdroje v pilotu

- `chmi_alerts`: ČHMÚ CAP výstrahy z `https://opendata.chmi.cz/meteorology/weather/alerts/cap/`.
- `chmi_hydro`: ČHMÚ hydrologické stanice z `https://opendata.chmi.cz/hydrology/`.
- `mock`: syntetická fixture pro offline testy kontraktu.

ČHMÚ CAP feed může poskytovat administrativní geokódy bez přesných polygonů. SIM proto ukládá `affectedAreas` a `geocodes`, ale pro mapový bod používá reprezentativní bod aktuálního bboxu. COP má tyto body vizualizovat jako výstražné anotace, nikoli jako přesnou hranici území.

## Projekce do Situation Data

Kvůli kompatibilitě je stejný obsah dostupný i přes:

```text
GET /situation-data/api/v1/cop/features?layers=warnings,flood&source=safety_data
```

Tato projekce je určena pro COP mapu, která už umí načítat `situation-data`. Nová implementace COP by měla preferovat čistý `safety-data` kontrakt, protože obsahuje plnou bezpečnostní sémantiku.

## Cache a zátěž

API používá řízenou cache:

- odpověďová cache podle bbox/layers/source/limit,
- in-flight coalescing pro paralelní stejné dotazy,
- stale-if-error fallback,
- dlouhá cache hydrologických metadat,
- per-station cache aktuálních hydrologických dat,
- limit `CHMI_HYDRO_MAX_STATIONS`.

Veřejné zdroje se nesmí dotazovat při každém dotazu tisíců COP klientů. COP má dotazovat SIM, SIM drží cache a dotazuje původní zdroje s konzervativní kadencí.

## Health a metadata

```text
GET /safety-data/health/live
GET /safety-data/health/ready
GET /safety-data/metrics
GET /safety-data/api/v1/layers
GET /safety-data/api/v1/sources
GET /safety-data/api/v1/config
```

`/config` nesmí vracet secrets. V pilotu nejsou pro ČHMÚ zdroje potřeba žádné bearer tokeny.
