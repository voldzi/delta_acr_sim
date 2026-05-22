# Safety Data source contract

**Status:** Implementováno pro pilot; kompatibilní backend kontrakt pro aktuální COM/COP adapter.

Safety Data API je samostatný COM zdroj pro veřejná bezpečnostní data. Kontrakt je oddělený od `situation-data`, protože bezpečnostní výstrahy mají jinou závažnost, platnost a auditní požadavky než obecný mapový kontext.

## Autoritativní endpoint pro COM backend

```text
GET /safety-data/api/v1/catalog
GET /safety-data/api/v1/features
```

Produkční URL za SIM gateway:

```text
https://sim.zeleznalady.cz/safety-data/api/v1/features
```

`/safety-data/api/v1/cop/features` zůstává jen jako kompatibilní alias pro existující backend adaptéry.

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

- `properties.layerId`: `public.safety.warnings` nebo `public.safety.flood`.
- `properties.providerId`: `sim.safety-data`.
- `properties.providerLayerId`: `safety.warnings` nebo `safety.flood`.
- `properties.layer`: `warnings` nebo `flood`.
- `properties.severity`: `info`, `advisory`, `warning`, `critical`.
- `properties.urgency` a `properties.certainty`.
- `properties.observedAt`, volitelně `effectiveAt` a `expiresAt`.
- `properties.license` s atribucí původního zdroje.
- `properties.metrics` pro číselné hodnoty, např. hladina, průtok, SPA.
- `properties.tags` pro strojově čitelné doplňky.
- `properties.providerProperties` pro provider-native hodnoty a auditní detail.

## Zdroje v pilotu

- `chmi_alerts`: ČHMÚ CAP výstrahy z `https://opendata.chmi.cz/meteorology/weather/alerts/cap/`.
- `chmi_hydro`: ČHMÚ hydrologické stanice z `https://opendata.chmi.cz/hydrology/`.
- `mock`: syntetická fixture pro offline testy kontraktu.

ČHMÚ CAP feed může poskytovat administrativní geokódy bez přesných polygonů. SIM proto ukládá `affectedAreas` a `geocodes`, ale pro mapový bod používá reprezentativní bod aktuálního bboxu. COM má tyto body vizualizovat jako výstražné anotace, nikoli jako přesnou hranici území.

## Projekce do Situation Data

Kvůli kompatibilitě je stejný obsah dostupný i přes:

```text
GET /situation-data/api/v1/features?layers=warnings,flood&source=safety_data
```

Tato projekce je určena pro COM mapu, která už umí načítat `situation-data`. Nová implementace COM by měla preferovat čistý `safety-data` kontrakt, protože obsahuje plnou bezpečnostní sémantiku.

## Cache a zátěž

API používá řízenou cache:

- odpověďová cache podle bbox/layers/source/limit,
- in-flight coalescing pro paralelní stejné dotazy,
- stale-if-error fallback,
- dlouhá cache hydrologických metadat,
- per-station cache aktuálních hydrologických dat,
- negativní cache pro hydrologické stanice, u kterých ČHMÚ vrací `404` pro aktuální data; pokud alespoň část stanic v bbox vrací platná data, jednotlivé `404` se neposílají jako COM warning,
- limit `CHMI_HYDRO_MAX_STATIONS`.

Veřejné zdroje se nesmí dotazovat při každém dotazu tisíců COM klientů. COM má dotazovat SIM, SIM drží cache a dotazuje původní zdroje s konzervativní kadencí.

CAP soubory ČHMÚ mohou obsahovat informační záznamy typu „žádná výstraha“ i jazykové varianty bez reálné výstrahy. SIM tyto záznamy nepublikuje jako mapové warnings, aby COM nedegradoval kvůli neaktivním nebo administrativním CAP položkám.

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
