# Situation Data Source Contract

**Status:** kompatibilní backend kontrakt. Pro nové providery a veřejnou dokumentaci je autoritativní source-neutral model v [../provider/00_INDEX.md](../provider/00_INDEX.md).

Tento kontrakt popisuje situační open-data vrstvy, které SIM poskytuje COM jako doplňkový kontext mapy. Kontrakt je oddělený od syntetických tracků i od veřejných letových tracků.

## Base URL

Lokální Docker pilot:

```text
http://docker.home.cz:5020/situation-data/api/v1
```

Publikovaný pilot:

```text
https://sim.zeleznalady.cz/situation-data/api/v1
```

## Endpoints

```http
GET /layers
GET /sources
GET /catalog
GET /config
GET /features?bbox=west,south,east,north&layers=weather,ground,mobile_network,traffic&limit=250
GET /cop/features?bbox=west,south,east,north&layers=weather,ground,mobile_network,traffic&limit=250
GET /mobile-coverage/metadata
GET /dem/metadata
```

## Map Catalog v1 metadata

`GET /catalog` je preferovaný metadata endpoint pro COM layer tree. Vrací provider metadata pro autoritativní source-neutral kontrakt Map Catalog v1:

```json
{
  "contractVersion": "provider-map-catalog-v1",
  "catalogVersion": "provider-map-catalog-v1",
  "providerId": "sim.situation-data",
  "generatedAt": "2026-05-22T08:00:00.000Z",
  "status": "online",
  "authority": {
    "contractVersion": "map-catalog-v1",
    "catalogVersion": "map-catalog-v1",
    "document": "docs/provider/02_MAP_CATALOG_PROVIDER_CONTRACT.md"
  },
  "layers": [],
  "sources": []
}
```

COM má používat provider katalog pro rozhodnutí, co je běžná mapová vrstva a co je pouze technický vstup. `enabled=true` ve starším `/sources` znamená jen to, že SIM zdroj běží; neznamená to, že ho má COM automaticky zobrazit jako checkbox v běžné mapě.

Klíčová pravidla katalogu:

- `public.mobile.network` je finální veřejná vrstva `mobile_network` ze zdroje `mobile_network_model`,
- `diagnostic.mobile.coverage` je diagnostická vrstva `mobile_coverage` ze zdroje `mobile_coverage_model`, `selectable=false`,
- `diagnostic.mobile.ctu_measurements` jsou diagnostická ČTÚ měření, `selectable=false`,
- `reference.infrastructure.communications` jsou referenční OSM věže, `defaultVisible=false` a `selectable=false`,
- `safety_data` v situation-data je označený jako `sourceRole=projection`; COM má pro primární safety vrstvy preferovat provider `sim.safety-data`.

## Feature projection

`GET /features` vrací GeoJSON `FeatureCollection`. `GET /cop/features` je kompatibilní alias pro současné backend adaptéry:

```json
{
  "contractVersion": "cop-situation-source-v1",
  "type": "FeatureCollection",
  "generatedAt": "2026-05-20T10:15:00.000Z",
  "source": {
    "sourceId": "situation-data-api",
    "sourceType": "PUBLIC_SITUATION_AGGREGATE",
    "generatedAt": "2026-05-20T10:15:00.000Z"
  },
  "query": {
    "bbox": { "west": 13.85, "south": 49.65, "east": 15.35, "north": 50.45 },
    "layers": ["weather", "ground", "mobile_network", "traffic"],
    "limit": 250,
    "sources": ["open_meteo", "ctu_nettest", "pid_gtfs_rt"]
  },
  "summary": {
    "featureCount": 250,
    "sourceCount": 3,
    "staleFeatureCount": 0,
    "warningCount": 0
  },
  "features": [],
  "sources": [],
  "warnings": []
}
```

## Feature properties

Každá feature musí mít tyto normalizované vlastnosti:

| Pole | Typ | Popis |
| --- | --- | --- |
| `featureId` | string | stabilní identifikátor v rámci zdroje |
| `layerId` | string | doporučené COM katalogové ID, např. `public.mobile.network` |
| `providerId` | string | identifikátor providera, např. `sim.situation-data` |
| `providerLayerId` | string | lokální vrstva providera, např. `mobile_network` |
| `layer` | `weather`, `ground`, `mobile`, `mobile_network`, `mobile_coverage`, `traffic`, `warnings`, `flood`, `air_quality` | mapová vrstva |
| `category` | string | detailnější typ objektu |
| `label` | string | lidsky čitelný název |
| `sourceId` | string | poskytovatel v SIM registry |
| `observedAt` | ISO datetime | čas pozorování nebo publikace |
| `validUntil` | ISO datetime, optional | konec platnosti, pokud zdroj poskytuje |
| `confidence` | number 0-1 | kvalita / důvěra agregátu |
| `stale` | boolean | zda je objekt starší než prahová hodnota |
| `severity` | `info`, `advisory`, `warning`, `critical` | priorita pro vizualizaci |
| `license` | object | licence a atribuce zdroje |
| `metrics` | object | číselné metriky vrstvy |
| `providerProperties` | object | provider-native hodnoty pro detail a audit |
| `raw` | object, optional | omezený původní payload pro ladění |

Traffic features ve vrstvě `traffic` navíc nesou stabilní civilní atributy, pokud je zdroj poskytuje:

| Pole | Typ | Popis |
| --- | --- | --- |
| `transportMode` | string | normalizovaný mód, např. `bus`, `tram`, `train`, `metro`, `trolleybus`, `road` |
| `routeShortName` | string | krátké označení linky/trasy |
| `destination` | string | cílová stanice/směr, pokud zdroj poskytuje |
| `delaySeconds` | number | zpoždění v sekundách |
| `vehicleId` | string | stabilní identifikátor vozidla ve zdroji |
| `tripId` | string | identifikátor jízdy/spoje ve zdroji |
| `occupancyStatus` | string | normalizovaný GTFS occupancy status |
| `occupancyPercent` | number | procentuální obsazenost, pokud zdroj poskytuje |
| `operator` | string | dopravce nebo systém, např. `PID`, `IDS JMK`, `NDIC/ŘSD` |
| `headingDeg` | number | směr pohybu ve stupních |
| `speedMps` | number | rychlost v m/s |

COM má pro civilní UI používat tato plochá pole v `properties`. Provider-specific PID/GTFS/IDS JMK/SRTI data jsou určena pouze pro detail, audit a diagnostiku v `providerProperties`; COM nemá parsovat raw provider payload jako běžný zdroj významu.

Coverage features ve vrstvě `mobile_coverage` navíc nesou:

| Pole | Typ | Popis |
| --- | --- | --- |
| `operator` | string | zatím `unknown`; připraveno pro pozdější operátorské vstupy |
| `technology` | `2G`, `4G`, `5G` | modelovaná technologie |
| `quality` | `good`, `fair`, `weak`, `none`, `unknown` | normalizovaná kvalita odhadu |
| `estimatedSignalDbm` | number | orientační odhad RSSI/RSRP v dBm podle fáze modelu |
| `modelVersion` | string | verze modelu, např. `coverage-v1` |
| `generatedAt` | ISO datetime | čas výpočtu cached výsledku |
| `resolutionM` | number | efektivní grid/polygon rozlišení v metrech |
| `demSource` | string | použitý DEM zdroj nebo `not-used-phase-1` |
| `assumptions` | object | použitý výškový/path-loss/terrain režim |
| `disclaimer` | string | upozornění, že nejde o garantované pokrytí operátora |

Unified mobile-network features ve vrstvě `mobile_network` navíc nesou:

| Pole | Typ | Popis |
| --- | --- | --- |
| `operator` | `aggregate`, `unknown` | `aggregate` znamená souhrnný odhad bez operátorských stavových dat |
| `technology` | `2G`, `4G`, `5G`, `mixed`, `unknown` | dominantní / filtrovaná technologie výsledku |
| `quality` | `good`, `fair`, `weak`, `none`, `unknown` | normalizovaný závěr pro COM |
| `status` | `ok`, `weak_signal`, `degraded_possible`, `outage_reported`, `unknown` | stavový závěr; bez partnerského feedu nejde o potvrzený výpadek BTS |
| `basis` | string[] | vstupy, ze kterých byl závěr složen, např. `CTU_NETTEST_MEASUREMENT`, `INFERRED_COVERAGE`, `NO_OPERATOR_BTS_STATUS` |
| `summary` | string | krátké české shrnutí pro detail v COM |
| `notices` | string[] | bezpečnostní a kvalitativní poznámky k interpretaci |
| `estimatedSignalDbm` | number | orientační odhad podle modelu a měření |
| `modelVersion` | string | verze sjednocujícího modelu |
| `disclaimer` | string | upozornění, že nejde o garantované pokrytí ani potvrzený stav konkrétní BTS |

## Podporované zdroje

| Source | Vrstvy | Popis |
| --- | --- | --- |
| `open_meteo` | `weather` | Obecné počasí u středu bbox, silně cacheované podle weather gridu. |
| `aviation_weather` | `weather` | NOAA AWC METAR/TAF pro letiště v bbox. SIM dotazuje AWC cacheovaně; COM AWC nevolá přímo. |
| `ctu_nettest` | `mobile` | ČTÚ NetTest otevřený export mobilních měření. |
| `ctu_stationary_mobile` | `mobile` | Oficiální stacionární měření mobilního signálu ČTÚ 2G/4G po operátorech. Historický diagnostický vstup, ne aktuální BTS stav. |
| `mobile_coverage_model` | `mobile_coverage` | SIM odhad mobilního pokrytí nad importovanými OSM věžemi. Publikuje polygonový grid s kvalitou `good/fair/weak/none/unknown`. |
| `mobile_network_model` | `mobile_network` | Sjednocený výstup pro COM. Kombinuje modelované coverage, ČTÚ NetTest měření, stacionární měření ČTÚ a dostupné infrastrukturní indicie do jednoho závěru s `quality`, `status`, `confidence`, `basis` a `summary`. |
| `pid_gtfs_rt` | `traffic` | PID/Golemio GTFS-RT vozidla pro dopravní kontext. |
| `idsjmk_vehicle_positions` | `traffic` | Volitelný IDS JMK/Brno open-data zdroj poloh vozidel. SIM drží feed cache a publikuje pouze bbox-filtered features. |
| `road_srti_lod` | `traffic` | NDIC/ŘSD SRTI dopravní události přes TamTam Research Linked Open Data SPARQL. SIM dotazuje upstream po TTL a COM používá pouze SIM odpověď. |
| `safety_data` | `warnings`, `flood` | Projekce Safety Data API do situačního kontraktu. |
| `ardos_partner` | `ground`, `mobile`, `traffic` | Neveřejný partnerský ARDOS zdroj. Vyžaduje `ARDOS_PARTNER_BASE_URL` a `ARDOS_PARTNER_TOKEN`. |
| `osm_postgis` | `ground`, `mobile` | OpenStreetMap extract v PostGIS. Preferovaně HA PostgreSQL/Patroni přes `haproxy.home.cz:5000`; lokální Docker PostGIS jen jako rebuildovatelný read-model/cache. |
| `osm_overpass` | `ground`, `mobile` | Jen omezený vývoj/pilot; veřejný Overpass nesmí být runtime backend pro tisíce uživatelů. |

## OpenStreetMap PostGIS

`osm_postgis` vrací referenční OSM objekty jako bodové features:

- `layer=ground`: nemocnice, lékárny, policie, hasičské stanice, ambulantní stanice, kryty, obecní úřady a vybrané nouzové body,
- `layer=mobile`: komunikační věže a mobilní infrastruktura odvozená z OSM tagů,
- `sourceId=osm_postgis`, licence `ODbL 1.0`, atribuce `OpenStreetMap contributors`.

COM má tento zdroj používat stejně jako ostatní situační features. Nejde o autoritativní registr IZS; je to referenční kontext pro mapu. Veřejný Overpass endpoint zůstává pouze vývojová záloha.

Health `/situation-data/health/ready` u `osm_postgis` vrací `sourceHealth` s `backend`, `objectCount`, `lastImportAt` a `lastImportAgeSeconds`. Metrics obsahují `situation_data_osm_postgis_objects`, `situation_data_osm_postgis_import_age_seconds` a cache metriky `situation_data_source_cache_hits/misses{source="osm_postgis"}`.

## Mobile Coverage Model

`mobile_coverage_model` vrací modelované coverage polygony jako samostatnou vrstvu `mobile_coverage`. Je to technický/modelový vstup pro `mobile_network`, ne běžná občanská vrstva. COM ho má zobrazovat pouze v diagnostice nebo při ladění modelu.

Vrstva je ve fázi 1 orientační:

- vstup: `public.osm_poi` z `osm_postgis`, kategorie `communications_tower`,
- výpočet: grid nad bbox, nejbližší věž, jednoduchý distance/path-loss odhad,
- technologie: `2G`, `4G`, `5G`,
- operator: `unknown`,
- DEM: Copernicus GLO-30 katalog může být dostupný, ale `coverage-v1` zatím neaplikuje line-of-sight; ve výstupu je proto `terrainApplied=false`.

Dotaz:

```http
GET /cop/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_coverage&source=mobile_coverage_model&technology=4G&limit=250
```

Volitelné parametry:

- `technology` nebo `technologies`: comma-separated filtr `2G,4G,5G`,
- `operator` nebo `operators`: zatím podporuje pouze `unknown`,
- `limit`: počet polygonů po aplikaci bbox filtru.

Metadata:

```http
GET /mobile-coverage/metadata
```

Příklad metadat:

```json
{
  "layerId": "mobile_coverage",
  "modelVersion": "coverage-v1",
  "generatedAt": "2026-05-21T00:00:00.000Z",
  "resolutionM": 1000,
  "technologies": ["2G", "4G", "5G"],
  "operators": ["unknown"],
  "qualityLevels": ["good", "fair", "weak", "none", "unknown"],
  "demSource": "copernicus-glo30-cz available; not applied by coverage-v1",
  "cacheTtlSeconds": 21600,
  "disclaimer": "Coverage is an estimate, not guaranteed service availability.",
  "assumptions": {
    "antennaHeightM": 30,
    "propagationModel": "distance-path-loss-lite",
    "terrainAware": false,
    "terrainDataAvailable": true,
    "terrainApplied": false,
    "demDatasetId": "copernicus-glo30-cz",
    "landCoverAware": false
  }
}
```

Health `/situation-data/health/ready` u `mobile_coverage_model` vrací `backend` a `objectCount` použitelných věží. Metrics obsahují `situation_data_mobile_coverage_towers`, `situation_data_mobile_coverage_backend_info` a cache metriky `situation_data_source_cache_hits/misses{source="mobile_coverage_model"}`.

## Mobile Network Model

`mobile_network_model` je preferovaný výstup pro COM. COM má primárně zobrazovat vrstvu `mobile_network`, ne skládat sám závěr z `mobile_coverage`, `ctu_nettest`, `ctu_stationary_mobile` a OSM bodů. `mobile_coverage` zůstává dostupné jako technická/modelová vrstva pro detail a ladění.

Dotaz:

```http
GET /cop/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_network&source=mobile_network_model&limit=250
```

Volitelné parametry:

- `technology` nebo `technologies`: comma-separated filtr `2G,4G,5G`,
- `operator` nebo `operators`: podporuje `aggregate` a `unknown`; reálný operátor bude přidán až po licenčně/partnersky čistém zdroji,
- `limit`: počet polygonů po aplikaci bbox filtru.

Interpretace:

- `quality` je hlavní hodnota pro barvu mapy: `good`, `fair`, `weak`, `none`, `unknown`,
- `status` je hlavní hodnota pro výstrahy: `weak_signal` a `degraded_possible` se mohou zobrazit jako riziko, `outage_reported` až po autorizovaném operátorském/partnerském feedu,
- `confidence` říká sílu kombinovaného závěru,
- `basis` ukazuje, jestli závěr stojí na měření, modelu, OSM infrastruktuře nebo jen na absenci lepších dat,
- `dataQuality` rozlišuje `modelled`, `observed`, `mixed`, `unknown`,
- `btsStatus=operator_feed_unavailable` a `operatorStatusAvailable=false` znamená, že nejde o potvrzený stav konkrétní BTS,
- `summary` a `notices` jsou připravené pro detail objektu v COM.

Bez autorizovaného operátorského/NOC feedu SIM nepublikuje potvrzený stav konkrétní BTS. Současný výstup je validovaný situační odhad pro občanské bezpečnostní zobrazení.

Health `/situation-data/health/ready` u `mobile_network_model` vrací `backend`, `objectCount` a závislé zdroje. `ctu_nettest` a `ctu_stationary_mobile` mají vlastní health položky s počtem měření a časem posledního měření. Metrics obsahují `situation_data_mobile_network_towers`, `situation_data_mobile_network_backend_info`, `situation_data_ctu_nettest_measurements`, `situation_data_ctu_stationary_mobile_measurements` a cache metriky `situation_data_source_cache_hits/misses{source="mobile_network_model"}`.

## DEM Catalog

SIM připravuje DEM katalog pro terrain-aware coverage model:

- source dataset: Copernicus DEM GLO-30 Public, 2021 release,
- object store: SeaweedFS S3,
- runtime cache: lokální filesystem mount,
- metadata: PostGIS tabulky `dem_datasets` a `dem_tiles`.

Metadata endpoint:

```http
GET /dem/metadata
```

Příklad odpovědi:

```json
{
  "enabled": true,
  "status": "ok",
  "datasetId": "copernicus-glo30-cz",
  "source": "copernicus-dem-glo30",
  "version": "2021",
  "resolutionM": 30,
  "tileCount": 36,
  "localTileCount": 36,
  "objectStoreTileCount": 36,
  "localCacheDir": "/dem-cache/copernicus-glo30",
  "objectStore": {
    "bucket": "sim-dem",
    "prefix": "copernicus-glo30/2021"
  },
  "warnings": []
}
```

COM DEM data přímo nepoužívá. Endpoint slouží pro dependency dohled a informaci, z jakého DEM bude SIM později generovat terrain-aware `mobile_coverage` a finální `mobile_network`.

COM musí vrstvu zobrazovat jako odhad, ne jako garantované pokrytí operátora. Doporučené barvy: `good` zelená, `fair` žlutá, `weak` oranžová, `none` červená nebo šedá, `unknown` šedá.

## Aviation Weather

`aviation_weather` vrací každou METAR stanici jako `weather` feature:

- `category=aviation_weather_station`,
- `tags.icaoId`, `tags.flightCategory`, `tags.tafAvailable`,
- `metrics.temperatureC`, `metrics.windSpeedMps`, `metrics.altimeterHpa`, `metrics.ceilingFt`,
- `severity` podle letové kategorie: `VFR=info`, `MVFR=advisory`, `IFR=warning`, `LIFR=critical`.

NOAA AWC uvádí limit 100 requestů/min a doporučuje omezit rozsah/frekvenci dotazů. SIM proto používá source cache a bbox kanonizaci.

## ARDOS partner source

`ardos_partner` není open-data. Aktivuje se jen po partnerské dohodě a tokenu. SIM očekává, že ARDOS vystaví již filtrovaný COM projection endpoint:

```http
GET /api/v1/features?bbox=west,south,east,north&layers=ground,traffic,mobile&limit=250
Authorization: Bearer <token>
```

SIM z partner payloadu přebírá geometrii, kategorii, čas, závažnost a metriky, ale `sourceId` normalizuje na `ardos_partner`. Ve veřejném COM zobrazení se nesmí publikovat osobní identifikátory dobrovolníků, přesné citlivé mise ani interní komunikační údaje.

## Chování při chybách

- Nevalidní `bbox` nebo `layers` vrací `400 VALIDATION_ERROR`.
- Výpadek jednoho zdroje se promítne do `warnings`; agregát má vrátit dostupné features z ostatních zdrojů.
- Pokud selžou všechny zdroje, endpoint stále může vrátit prázdnou kolekci s warnings.

## COM doporučení

- Dotazovat podle bbox aktuální mapy, ne plošně celou ČR.
- Default `limit=250`.
- Layer tree a defaultní viditelnost řídit z `GET /catalog`, ne ze staršího `/sources`.
- Weather a traffic vrstvy zobrazovat jako kontext. `pid_gtfs_rt` obsahuje pohybující se vozidla veřejné dopravy, ale nejsou to COM tracky ani letecké cíle.
- `mobile_network` zobrazovat jako hlavní mobilní vrstvu s legendou kvality a upozorněním, že jde o odhad, ne potvrzený stav konkrétní BTS.
- `mobile_coverage` používat jen jako technický/detailní vstup, pokud je potřeba ladit model.
- `aviation_weather` zobrazovat jako letištní počasí, ne jako tracky.
- `ardos_partner` zobrazovat jen ve views, kde uživatel má oprávnění pro partnerská data.
- U každého objektu zobrazovat zdroj a licenci.
