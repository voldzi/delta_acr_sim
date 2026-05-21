# Situation Data Source Contract

Tento kontrakt popisuje situační open-data vrstvy, které SIM poskytuje COPu jako doplňkový kontext mapy. Kontrakt je oddělený od syntetických COP tracků i od veřejných letových tracků.

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
GET /config
GET /features?bbox=west,south,east,north&layers=weather,ground,mobile,traffic&limit=250
GET /cop/features?bbox=west,south,east,north&layers=weather,ground,mobile,traffic&limit=250
GET /mobile-coverage/metadata
```

## COP projection

`GET /cop/features` vrací GeoJSON `FeatureCollection`:

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
    "layers": ["weather", "ground", "mobile", "traffic"],
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
| `layer` | `weather`, `ground`, `mobile`, `mobile_coverage`, `traffic`, `warnings`, `flood`, `air_quality` | mapová vrstva |
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
| `raw` | object, optional | omezený původní payload pro ladění |

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

## Podporované zdroje

| Source | Vrstvy | Popis |
| --- | --- | --- |
| `open_meteo` | `weather` | Obecné počasí u středu bbox, silně cacheované podle weather gridu. |
| `aviation_weather` | `weather` | NOAA AWC METAR/TAF pro letiště v bbox. SIM dotazuje AWC cacheovaně; COP AWC nevolá přímo. |
| `ctu_nettest` | `mobile` | ČTÚ NetTest otevřený export mobilních měření. |
| `mobile_coverage_model` | `mobile_coverage` | SIM odhad mobilního pokrytí nad importovanými OSM věžemi. Publikuje polygonový grid s kvalitou `good/fair/weak/none/unknown`. |
| `pid_gtfs_rt` | `traffic` | PID/Golemio GTFS-RT vozidla pro dopravní kontext. |
| `safety_data` | `warnings`, `flood` | Projekce Safety Data API do situačního kontraktu. |
| `ardos_partner` | `ground`, `mobile`, `traffic` | Neveřejný partnerský ARDOS zdroj. Vyžaduje `ARDOS_PARTNER_BASE_URL` a `ARDOS_PARTNER_TOKEN`. |
| `osm_postgis` | `ground`, `mobile` | OpenStreetMap extract v PostGIS. Preferovaně HA PostgreSQL/Patroni přes `haproxy.home.cz:5000`; lokální Docker PostGIS jen jako rebuildovatelný read-model/cache. |
| `osm_overpass` | `ground`, `mobile` | Jen omezený vývoj/pilot; veřejný Overpass nesmí být runtime backend pro tisíce uživatelů. |

## OpenStreetMap PostGIS

`osm_postgis` vrací referenční OSM objekty jako bodové features:

- `layer=ground`: nemocnice, lékárny, policie, hasičské stanice, ambulantní stanice, kryty, obecní úřady a vybrané nouzové body,
- `layer=mobile`: komunikační věže a mobilní infrastruktura odvozená z OSM tagů,
- `sourceId=osm_postgis`, licence `ODbL 1.0`, atribuce `OpenStreetMap contributors`.

COP má tento zdroj používat stejně jako ostatní situační features. Nejde o autoritativní registr IZS; je to referenční kontext pro mapu. Veřejný Overpass endpoint zůstává pouze vývojová záloha.

Health `/situation-data/health/ready` u `osm_postgis` vrací `sourceHealth` s `backend`, `objectCount`, `lastImportAt` a `lastImportAgeSeconds`. Metrics obsahují `situation_data_osm_postgis_objects`, `situation_data_osm_postgis_import_age_seconds` a cache metriky `situation_data_source_cache_hits/misses{source="osm_postgis"}`.

## Mobile Coverage Model

`mobile_coverage_model` vrací modelované coverage polygony jako samostatnou vrstvu `mobile_coverage`. COP nemá počítat coverage, stahovat DEM ani dotazovat OSM; používá pouze hotový výstup SIM.

Vrstva je ve fázi 1 orientační:

- vstup: `public.osm_poi` z `osm_postgis`, kategorie `communications_tower`,
- výpočet: grid nad bbox, nejbližší věž, jednoduchý distance/path-loss odhad,
- technologie: `2G`, `4G`, `5G`,
- operator: `unknown`,
- DEM: zatím `not-used-phase-1`, `terrainAware=false`.

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
  "demSource": "not-used-phase-1",
  "cacheTtlSeconds": 21600,
  "disclaimer": "Coverage is an estimate, not guaranteed service availability.",
  "assumptions": {
    "antennaHeightM": 30,
    "propagationModel": "distance-path-loss-lite",
    "terrainAware": false,
    "landCoverAware": false
  }
}
```

Health `/situation-data/health/ready` u `mobile_coverage_model` vrací `backend` a `objectCount` použitelných věží. Metrics obsahují `situation_data_mobile_coverage_towers`, `situation_data_mobile_coverage_backend_info` a cache metriky `situation_data_source_cache_hits/misses{source="mobile_coverage_model"}`.

COP musí vrstvu zobrazovat jako odhad, ne jako garantované pokrytí operátora. Doporučené barvy: `good` zelená, `fair` žlutá, `weak` oranžová, `none` červená nebo šedá, `unknown` šedá.

## Aviation Weather

`aviation_weather` vrací každou METAR stanici jako `weather` feature:

- `category=aviation_weather_station`,
- `tags.icaoId`, `tags.flightCategory`, `tags.tafAvailable`,
- `metrics.temperatureC`, `metrics.windSpeedMps`, `metrics.altimeterHpa`, `metrics.ceilingFt`,
- `severity` podle letové kategorie: `VFR=info`, `MVFR=advisory`, `IFR=warning`, `LIFR=critical`.

NOAA AWC uvádí limit 100 requestů/min a doporučuje omezit rozsah/frekvenci dotazů. SIM proto používá source cache a bbox kanonizaci.

## ARDOS partner source

`ardos_partner` není open-data. Aktivuje se jen po partnerské dohodě a tokenu. SIM očekává, že ARDOS vystaví již filtrovaný COP projection endpoint:

```http
GET /api/v1/cop/features?bbox=west,south,east,north&layers=ground,traffic,mobile&limit=250
Authorization: Bearer <token>
```

SIM z partner payloadu přebírá geometrii, kategorii, čas, závažnost a metriky, ale `sourceId` normalizuje na `ardos_partner`. Ve veřejném COP zobrazení se nesmí publikovat osobní identifikátory dobrovolníků, přesné citlivé mise ani interní komunikační údaje.

## Chování při chybách

- Nevalidní `bbox` nebo `layers` vrací `400 VALIDATION_ERROR`.
- Výpadek jednoho zdroje se promítne do `warnings`; agregát má vrátit dostupné features z ostatních zdrojů.
- Pokud selžou všechny zdroje, endpoint stále může vrátit prázdnou kolekci s warnings.

## COP doporučení

- Dotazovat podle bbox aktuální mapy, ne plošně celou ČR.
- Default `limit=250`.
- Weather, mobile a traffic vrstvy zobrazovat jako kontext. `pid_gtfs_rt` obsahuje pohybující se vozidla veřejné dopravy, ale nejsou to COP tracky ani letecké cíle.
- `mobile_coverage` zobrazovat jako průhlednou polygonovou vrstvu s legendou kvality a upozorněním, že jde o odhad.
- `aviation_weather` zobrazovat jako letištní počasí, ne jako tracky.
- `ardos_partner` zobrazovat jen ve views, kde uživatel má oprávnění pro partnerská data.
- U každého objektu zobrazovat zdroj a licenci.
