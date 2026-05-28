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
- `layers=weather_alerts,fire,flood,boundary_admin`.
- `layers=warnings` je pouze kompatibilní alias pro starší adaptéry.
- `source=chmi_alerts,chmi_hydro,nasa_firms,admin_boundaries` nebo `source=mock`.
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

Každá feature nese minimálně:

- `properties.layerId`: `public.safety.weather_alerts`, `public.safety.fire`, `public.safety.flood` nebo `public.boundary.admin`.
- `properties.providerId`: `sim.safety-data`.
- `properties.providerLayerId`: `safety.weather_alerts`, `safety.fire`, `safety.flood` nebo `boundary.admin`.
- `properties.layer`: `weather_alerts`, `fire`, `flood` nebo `boundary_admin`.
- `properties.hazardType`, `properties.status`, `properties.validFrom`, `properties.validUntil`, `properties.updatedAt`.
- `properties.source`, `properties.sourceName`, `properties.basis`, `properties.styleHint`, `properties.iconHint`.
- `properties.severity`: `info`, `advisory`, `warning`, `critical`.
- `properties.urgency` a `properties.certainty`.
- `properties.observedAt`, volitelně `effectiveAt` a `expiresAt`.
- `properties.license` s atribucí původního zdroje.
- `properties.metrics` pro číselné hodnoty, např. hladina, průtok, SPA.
- `properties.tags` pro strojově čitelné doplňky.
- `properties.providerProperties` pro provider-native hodnoty a auditní detail.

Specializovaná pole:

- Požáry: `fireStatus`, `detectedAt`, `sourceSatellite`, `sourceIncident`, `confidence`, `intensity`, `frp`.
  - `fireStatus=detected` znamená satelitní detekci nebo tepelnou anomálii.
  - `fireStatus=risk` znamená oficiální meteorologické požární nebezpečí, typicky ČHMÚ CAP výstrahu.
- Povodně: `riverName`, `stationId`, `waterLevelCm`, `discharge`, `floodStage`, `trend`, `basin`, `affectedArea`.
  - `floodStage` je normalizovaný stupeň `0..4` podle dostupných hladinových nebo průtokových SPA prahů ČHMÚ.
  - `trend` je `rising`, `falling`, `stable` nebo `unknown`, počítaný z posledních dvou hodnot časové řady.
  - `metrics` obsahují např. `waterLevelRateCmPerHour`, `flowRateM3sPerHour`, `trendWindowMinutes`, `catchmentAreaKm2` a prahy `spa1..spa4`.
- Hranice: `adminLevel`, `name`, `code`, `countryCode`, `validFrom`, `source`.

## Zdroje v pilotu

- `chmi_alerts`: ČHMÚ CAP výstrahy z `https://opendata.chmi.cz/meteorology/weather/alerts/cap/`; požární nebezpečí se kromě `public.safety.weather_alerts` projektuje také do `public.safety.fire` jako `fire_weather_risk`.
- `chmi_hydro`: ČHMÚ hydrologické stanice z `https://opendata.chmi.cz/hydrology/`; SIM používá aktuální časové řady i metadata stanic pro trend, SPA klasifikaci, průtokové prahy, plochu povodí a hydrologické pořadí.
- `nasa_firms`: NASA FIRMS aktivní požáry/tepelné anomálie z Area CSV API; vyžaduje `NASA_FIRMS_MAP_KEY`.
- `admin_boundaries`: referenční administrativní hranice. Produkčně čte lokální/PostGIS read-model `public.osm_admin_boundary`; pokud není DB nebo view k dispozici, vrací jen hrubý seed ČR s warningem.
- `mock`: syntetická fixture pro offline testy kontraktu.

ČHMÚ CAP feed poskytuje administrativní geokódy, typicky `CISORP` a `EMMA_ID`. SIM tyto kódy páruje přes cachovaný číselník ČSÚ CISORP na lokální/PostGIS hranice `public.osm_admin_boundary`; pokud je shoda dostupná, `weather_alerts` vrací `Polygon`/`MultiPolygon` pro zasažené správní území. Pokud PostGIS nebo číselník nejsou dostupné, SIM zachová `affectedAreas` a `geocodes` a vrátí reprezentativní bod s `properties.metrics.geometryMode=representative_point`.

Podrobnější vyhodnocení českých požárních zdrojů je v `docs/situation-data/05_FIRE_DATA_SOURCES_CZ.md`.

## Projekce do Situation Data

Kvůli kompatibilitě je stejný obsah dostupný i přes:

```text
GET /situation-data/api/v1/features?layers=warnings,fire,flood,boundary_admin&source=safety_data
```

Tato projekce je určena pro starší serverové adaptéry COM, které už umí načítat `situation-data`. Nová implementace COM by měla preferovat čistý `safety-data` kontrakt, protože obsahuje plnou bezpečnostní sémantiku. Projekce zachovává `MultiPolygon` geometrii a v `providerProperties` předává nativní safety atributy jako `fireStatus`, `floodStage`, `adminLevel`, `basis`, `sourceName` a původní provider identifikátory.

## Cache a zátěž

API používá řízenou cache:

- odpověďová cache podle bbox/layers/source/limit,
- in-flight coalescing pro paralelní stejné dotazy,
- stale-if-error fallback,
- dlouhá cache hydrologických metadat,
- per-station cache aktuálních hydrologických dat,
- negativní cache pro hydrologické stanice, u kterých ČHMÚ vrací `404` pro aktuální data; pokud alespoň část stanic v bbox vrací platná data, jednotlivé `404` se neposílají jako COM warning,
- limit `CHMI_HYDRO_MAX_STATIONS`.
- NASA FIRMS zdroj drží vlastní source-level cache alespoň 10 minut a bez `NASA_FIRMS_MAP_KEY` se nedotazuje externího API.
- Admin hranice se čtou z lokální/PostGIS materializované view s TTL `SAFETY_DATA_ADMIN_BOUNDARY_CACHE_TTL_SECONDS`; geometrie se vybírá ze zjednodušených sloupců podle velikosti bboxu.
- ČHMÚ CAP polygonizace drží číselník CISORP z `CHMI_ORP_CODELIST_URL` v dlouhé cache a hranice čte pouze z lokálního PostGIS read-modelu, ne z veřejného Overpass runtime.

Veřejné zdroje se nesmí dotazovat při každém dotazu tisíců COM klientů. COM má dotazovat SIM, SIM drží cache a dotazuje původní zdroje s konzervativní kadencí.

CAP soubory ČHMÚ mohou obsahovat informační záznamy typu „žádná výstraha“ i jazykové varianty bez reálné výstrahy. SIM tyto záznamy nepublikuje jako mapové warnings, aby COM nedegradoval kvůli neaktivním nebo administrativním CAP položkám.

## Health a metadata

```text
GET /safety-data/health/live
GET /safety-data/health/ready
GET /safety-data/api/v1/observability
GET /safety-data/api/v1/layers
GET /safety-data/api/v1/sources
GET /safety-data/api/v1/config
```

Interní Prometheus endpoint `GET /metrics` běží na službě `safety-data-api` uvnitř docker sítě. Veřejný web proxy endpoint `/safety-data/metrics` záměrně vrací 404, aby se nepublikovaly provozní detaily.

Interní `/metrics` obsahuje aggregate cache metriky i per-source cache metriky:

- `safety_data_cache_hits/misses/stale_hits/errors`,
- `safety_data_source_cache_hits/misses/stale_hits/errors{source="chmi_alerts|chmi_hydro|nasa_firms|admin_boundaries"}`,
- `safety_data_last_feature_count`,
- `safety_data_last_layer_features{layer="weather_alerts|fire|flood|boundary_admin"}`,
- `safety_data_last_generated_age_seconds`.

`/api/v1/observability` je JSON endpoint pro SIM Overview. Vrací aggregate cache, `sourceCaches`, `dataFreshness` a `lastResult`, aby bylo vidět stáří poslední odpovědi, počet features, varování a cache hit-rate bez dotazování externích zdrojů.

`/config` nesmí vracet secrets. V pilotu nejsou pro ČHMÚ zdroje potřeba žádné bearer tokeny.
`NASA_FIRMS_MAP_KEY` se v `/config` nevrací; endpoint ukáže jen `authConfigured=true/false`.
