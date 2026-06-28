# Safety Data source contract

**Status:** Implementováno pro pilot; kompatibilní backend kontrakt pro aktuální COM/COP adapter.

Safety Data API je samostatný COM zdroj pro veřejná bezpečnostní data. Kontrakt je oddělený od `situation-data`, protože bezpečnostní výstrahy mají jinou závažnost, platnost a auditní požadavky než obecný mapový kontext.

## Autoritativní endpoint pro COM backend

```text
GET /safety-data/api/v1/catalog
GET /safety-data/api/v1/features
GET /safety-data/api/v1/hydro/stations/{stationId}/observations
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

Detail hlásného profilu podporuje query parametry:

- `from=ISO-8601` a `to=ISO-8601`; pokud chybí, SIM použije konfigurované okno historie a předpovědi.
- `series=H,Q,TH,H_F,Q_F`, kde `H` je vodní stav, `Q` průtok, `TH` teplota vody a `_F` jsou předpovědní řady.

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

### ČHMÚ CAP kanonická taxonomie

ČHMÚ CAP výstrahy se v SIM normalizují podle strojových kódů, ne podle textu
události. SIM slučuje jazykové `info` bloky jedné CAP události do jedné mapové
feature a texty předává v `properties.localized` a
`properties.providerProperties.localized`.

Pro ČHMÚ výstrahy jsou navíc vyplněna pole:

- `properties.typeCode`: kanonický SIM typ, například
  `weather.temperature.high`, `weather.ice.slippery_roads`,
  `hydro.flood.warning`, `air_quality.pm10.smog`.
- `properties.sourceCode`: zdrojový ČHMÚ kód, například `I.2`, `VII.1`,
  `XI.2`, `SMOGSIT.PM10`.
- `properties.sourceSystem`: typicky `CHMI_SIVS`.
- `properties.providerProperties.schemaVersion=sim.provider.v2`.
- `properties.providerProperties.taxonomy`: auditní blok s `sourceCode`,
  `typeCode`, `domain`, `category`, `hazardType`, `classificationBasis`,
  `awareness_type`, `awareness_level` a případným `criterion`.
- `properties.providerProperties.presentation`: doporučený `iconKey`,
  `styleKey`, `detailTemplate` a primární jazyk.
- `properties.providerProperties.notification`: doporučení, zda je produkt
  vhodný jako kandidát pro COP notifikaci. Rozhodnutí o adresátech a doručení
  zůstává v COP.

Podporované ČHMÚ kódy zahrnují nový SIVS číselník: vysoké/nízké teploty,
zátěž teplem/chladem, vítr, sníh a sněhové jevy, náledí a kluzké povrchy,
ledovku/námrazu, bouřky, déšť, povodňové jevy včetně dotoku, požární
nebezpečí, nezařazené jevy, smogové a regulační situace pro `O3`, `PM10`,
`SO2`, `NO2`, výhled a sucho.

`classificationBasis=source_code` znamená, že SIM použil explicitní ČHMÚ
`eventCode`. `classificationBasis=awareness_type` je strojový fallback z CAP
parametru. `classificationBasis=text_fallback` je poslední fallback pro starší
nebo neúplné payloady a má být provozně sledován.

Produkty typu „žádná výstraha“, „žádný výhled nebezpečných jevů“ nebo jejich
anglické varianty SIM nepublikuje jako mapové safety features. Výhled
nebezpečných jevů s obsahem může být publikován jako `weather.outlook`, ale
není notifikovatelný bez samostatného pravidla COP.

## Lehký summary/detail kontrakt

Plný `GET /safety-data/api/v1/features` je mapový GeoJSON stream a může nést
velké administrativní polygony výstrah. COP má pro seznamy, dashboardy,
počítadla a náhledy používat lehký endpoint:

```http
GET /safety-data/api/v1/features/summary?bbox=...&layers=weather_alerts,fire,flood&limit=250
```

Odpověď má `contractVersion=sim-provider-feature-summary-v1` a každá položka
obsahuje `featureId`, `layerId`, `providerLayerId`, `sourceId`, `label`,
`severity`, `status`, `stale`, `confidence`, časovou platnost, `typeCode`,
`sourceCode`, `geometrySummary`, doporučené `styleHint`/`iconHint` a odkazy:

- `links.detail`: detail bez těžké geometrie,
- `links.geometry`: samostatná geometrie pro daný prvek.

Po kliknutí na feature má COP otevřít:

```http
GET /safety-data/api/v1/features/{featureId}?bbox=...&layers=...&source=...
```

Detail vrací `contractVersion=sim-provider-feature-detail-v1`, sanitizované
`properties`, `localized`, `providerProperties` a odkazy na geometrii nebo
specializovaný zdrojový detail. Raw upstream payloady se v detailu nevrací.
Pokud klient potřebuje polygon pro highlight nebo detailní kreslení, dotáhne:

```http
GET /safety-data/api/v1/features/{featureId}/geometry?bbox=...&layers=...&source=...
```

Číselníky pro COP jsou dostupné zde:

```http
GET /safety-data/api/v1/taxonomy
```

Endpoint obsahuje vrstvy, normalized severity a autoritativní ČHMÚ SIVS/CAP
slovník. COP má typ jevu odvozovat z `typeCode`/`sourceCode` a tohoto
číselníku, ne z českého nebo anglického textu výstrahy.

Specializovaná pole:

- Požáry: `fireStatus`, `detectedAt`, `sourceSatellite`, `sourceIncident`, `confidence`, `intensity`, `frp`.
  - `fireStatus=detected` znamená satelitní detekci nebo tepelnou anomálii.
  - `fireStatus=risk` znamená oficiální meteorologické požární nebezpečí, typicky ČHMÚ CAP výstrahu.
- Povodně: `riverName`, `stationId`, `waterLevelCm`, `discharge`, `floodStage`, `trend`, `basin`, `affectedArea`.
  - `floodStage` je normalizovaný stupeň `0..4` podle dostupných hladinových nebo průtokových SPA prahů ČHMÚ.
  - `trend` je `rising`, `falling`, `stable` nebo `unknown`, počítaný z posledních dvou hodnot časové řady.
  - `waterTemperatureC` je poslední dostupná teplota vody, pokud ji profil poskytuje.
  - `detailUrl`/`timelineUrl` ukazuje na detail hlásného profilu pro graf časové řady.
  - `forecastAvailable=true` a `forecastUntil` znamenají, že ČHMÚ v aktuálním payloadu poskytl předpovědní řady `H_F` nebo `Q_F`.
  - `metrics` obsahují např. `waterLevelRateCmPerHour`, `flowRateM3sPerHour`, `trendWindowMinutes`, `forecastHorizonHours`, `catchmentAreaKm2` a prahy `spa1..spa4`.
- Hranice: `adminLevel`, `name`, `code`, `countryCode`, `validFrom`, `source`.

## Detail hlásného profilu pro COP

COP má pro `public.safety.flood` zařadit hlásné profily jako selectable body. Z mapové feature bere stav výstrahy a popisek, detailní graf se dotahuje až při otevření detailu přes `properties.detailUrl`.

Detail endpoint vrací kontrakt:

```json
{
  "contractVersion": "chmi-hydro-station-detail-v1",
  "providerId": "sim.safety-data",
  "sourceId": "chmi_hydro",
  "station": {
    "stationId": "0-203-1-239000",
    "stationCode": "239000",
    "stationName": "Benešov nad Ploučnicí",
    "streamName": "Ploučnice"
  },
  "thresholds": {
    "waterLevel": { "unit": "cm", "dry": 88, "spa1": 140, "spa2": 170, "spa3": 190 },
    "discharge": { "unit": "m3/s", "dry": 3.21, "spa1": 50.3, "spa2": 87.7, "spa3": 113 }
  },
  "series": [],
  "chart": {
    "panels": []
  }
}
```

COP výstražně vyhodnocuje pouze mapovou feature:

- `severity=info` pro `floodStage=0`, tedy monitorovací stav bez SPA.
- `severity=advisory` pro `floodStage=1`, tedy 1. SPA.
- `severity=warning` pro `floodStage=2`, tedy 2. SPA.
- `severity=critical` pro `floodStage>=3`, tedy 3. SPA nebo extrémní stupeň.
- `trend=rising` má v detailu zvýraznit rostoucí stav, ale samo o sobě nemá spouštět kritickou notifikaci bez vztahu k SPA nebo pravidlům COP.
- Technické `warnings`, `stale=true` a chyby upstreamu patří do provozního dohledu, ne do civilních push notifikací.

Detail grafu má kopírovat sémantiku ČHMÚ profilu:

- horní panel `Vodní stav`: osa Y v centimetrech, měřená řada `H` jako plná modrá čára/plocha, předpověď `H_F` jako modrá přerušovaná čára, suchý stav a SPA prahy jako vodorovné referenční čáry, aktuální čas jako svislá červená tečkovaná čára;
- dolní panel `Průtok`: osa Y v `m3/s`, měřená řada `Q` a předpověď `Q_F` stejným stylem, průtokové SPA prahy jako vodorovné referenční čáry;
- volitelný třetí menší panel `Teplota vody` zobrazí `TH`, pokud je dostupná;
- legenda má rozlišit měření, předpověď, sucho, SPA 1-4 a aktuální čas;
- prázdná série se v grafu nevykresluje, ale panel může zůstat připravený, pokud jej vrací `chart.panels`.

## Vztah k uzivatelskym notifikacim

Safety Data API je vstup pro rozhodovani COP, ne notifikacni sluzba. SIM
neposila push notifikace a nezna uzivatele, zarizeni, skupiny ani sledovane
oblasti.

Katalogove vrstvy `public.safety.weather_alerts`, `public.safety.fire` a
`public.safety.flood` obsahuji metadata `notificationPolicy`, ktera popisuji,
ze vrstva je vhodna pro civilni vyhodnoceni notifikace. COP ma z feature
vytvorit stabilni `Idempotency-Key` a poslat pozadavek do CSM Messaging pouze
tehdy, kdyz se udalost tyka konkretniho uzivatele, skupiny nebo sledovane
oblasti.

Technicke `warnings`, stale stav zdroju a degradace upstreamu patri do
provozniho dohledu. Nesmí se posilat obcanum jako safety push, pokud nejsou
soucasti realne safety feature.

Detailni kontrakt je v
[`14_CSM_NOTIFICATION_INPUT_CONTRACT.md`](14_CSM_NOTIFICATION_INPUT_CONTRACT.md).

## Zdroje v pilotu

- `chmi_alerts`: ČHMÚ CAP výstrahy z `https://opendata.chmi.cz/meteorology/weather/alerts/cap/`; požární nebezpečí se kromě `public.safety.weather_alerts` projektuje také do `public.safety.fire` jako `fire_weather_risk`.
- `chmi_hydro`: ČHMÚ hydrologické stanice z `https://opendata.chmi.cz/hydrology/`; SIM používá aktuální časové řady, omezený `recent` backfill a lokální JSONL historii pro trend, SPA klasifikaci, průtokové prahy, teplotu vody, plochu povodí a hydrologické pořadí.
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
- krátká source-level current snapshot cache `CHMI_HYDRO_CURRENT_SNAPSHOT_CACHE_TTL_SECONDS` pro mapové dotazy bez `includeRaw`; snapshot funguje jako runtime read-model aktuálních normalizovaných hlásných profilů a následně se filtruje podle požadovaného bboxu,
- per-station cache aktuálních hydrologických dat,
- samostatná kapacita per-station cache `CHMI_HYDRO_STATION_CACHE_MAX_ENTRIES`, aby celostátní dotaz nevyhazoval část stanic z obecné `SAFETY_DATA_CACHE_MAX_ENTRIES`,
- lokální append-only historii ČHMÚ hlásných profilů v `${SAFETY_DATA_DIR}/chmi-hydro/history/*.jsonl`; data se deduplikují podle série a času a plní se při dotazech na mapovou feature i detail,
- omezený `recent` backfill pro detail hlásného profilu podle `CHMI_HYDRO_DETAIL_BACKFILL_DAYS`,
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

`/api/v1/observability` je JSON endpoint pro SIM Overview. Vrací aggregate cache, `sourceCaches`, `dataFreshness` a `lastResult`, aby bylo vidět stáří poslední odpovědi, počet features, varování, cache hit-rate a časy `lastSuccessAt`/`lastErrorAt` bez dotazování externích zdrojů. Historický čítač `errors` sám o sobě neznamená degradaci; degradace cache se odvozuje z toho, že poslední chyba je novější než poslední úspěšný refresh.

`/config` nesmí vracet secrets. V pilotu nejsou pro ČHMÚ zdroje potřeba žádné bearer tokeny.
`NASA_FIRMS_MAP_KEY` se v `/config` nevrací; endpoint ukáže jen `authConfigured=true/false`.
