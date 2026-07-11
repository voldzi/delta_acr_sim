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
GET /observability
GET /mobile-coverage/metadata
GET /radio/profiles
POST /radio/profiles
POST /radio/link-check
POST /radio/coverage
POST /radio/site-search
GET /weather-stations/{stationId}/detail
GET /dem/metadata
GET /routing/profiles
POST /routing/route
POST /routing/alternatives
POST /routing/isochrone
POST /routing/nearest-access
```

## Search Data pro COP AI kontext

SIM poskytuje samostatné normalizované rozhraní pro AI vyhledávání kontextu nad
mapou. Nejde o chat ani o rozhodovací AI. SIM zde vystupuje jako server-side
zdroj pravdy, který dodává stabilní entity, geometrii, klasifikaci, kvalitu dat,
časovou platnost a pravidla zacházení. COP nad tím staví uživatelský dotaz,
oprávnění, RAG/LLM orchestrace, audit a mapové akce.

Privátní base URL pro COP backend:

```text
http://docker.home.cz:5020/search-data/api/v1
```

Veřejný reverzní proxy používá stejnou cestu, ale provider endpointy mají
zůstat server-to-server a nemají být volané přímo z klienta:

```text
https://sim.zeleznalady.cz/search-data/api/v1
```

Endpointy:

```http
GET /search-data/api/v1/taxonomy
GET /search-data/api/v1/entities?limit=1000&cursor=...
GET /search-data/api/v1/entities/{providerEntityId}
POST /search-data/api/v1/query
GET /search-data/api/v1/observability
```

Kompatibilní interní alias je dostupný také jako `/api/v1/search-data/*`.

Kontrakt odpovědí:

| Pole                                                     | Význam                                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `contractVersion`                                        | vždy `sim-search-source-v1`                                                                                                               |
| `providerId`                                             | vždy `sim.search-data`                                                                                                                    |
| `providerEntityId`                                       | stabilní SIM identifikátor entity pro detail a deduplikaci                                                                                |
| `entityType`                                             | autoritativní typ entity, ne jazykově odvozený text                                                                                       |
| `sourceSystem`                                           | původní zdroj/read-model, např. `osm_reference`, `weather_forecast`, `chmi_weather_radar`, `chmi_alerts`, `chmi_hydro`, `safety_data`     |
| `sourceEntityId`                                         | identifikátor objektu v původním zdroji                                                                                                   |
| `sourceAuthority`                                        | `official`, `internal_verified`, `partner_verified`, `reference`, `community_verified`, `community_unverified`, `modelled` nebo `unknown` |
| `dataQuality`                                            | `official_observed`, `official_warning`, `verified_reference`, `reference`, `modelled`, `mixed` nebo `unknown`                            |
| `title`, `summary`, `searchableText`, `aliases`          | normalizovaný text pro UI, indexaci a RAG grounding                                                                                       |
| `localized.cs`, `localized.en`                           | lokalizované texty pro COP UI a AI kontext                                                                                                |
| `geometry`, `centroid`                                   | GeoJSON geometrie ve WGS84 a bod pro řazení/vzdálenosti                                                                                   |
| `address`                                                | správní/adresní zařazení, pokud je ve zdroji dostupné                                                                                     |
| `status`, `severity`, `confidence`                       | stav, závažnost a důvěra normalizované entity                                                                                             |
| `layerIds`, `tags`                                       | doporučené napojení na COP vrstvy a vyhledávací tagy                                                                                      |
| `metrics`                                                | strojově čitelné hodnoty, např. závažnost, pravděpodobnost, voda, průtok, srážky, vítr, radar/nowcast stav                                |
| `classification`, `handling`, `visibility`, `allowedUse` | pravidla klasifikace, zobrazitelnosti a povoleného použití                                                                                |
| `positionQuality`                                        | přesnost polohy: `exact`, `centroid`, `approximate` nebo `unknown`                                                                        |
| `providerProperties`                                     | omezené provider-native hodnoty pro audit a detail                                                                                        |
| `deleted`                                                | v1 vrací aktuální živý/read-model stav; tombstones jsou označený follow-up                                                                |

Podporované `entityType` hodnoty v první produkční verzi:

```text
police_station, fire_station, hospital, medical_emergency,
hydro_station, hydro_measurement, weather_warning, safety_alert,
weather_forecast, weather_nowcast, weather_radar, thunderstorm_risk,
fire_incident, flood_risk_area, road_closure, shelter,
evacuation_point, municipality, district, region,
critical_infrastructure, public_resource
```

Pro dotazy typu „bude pršet“, „srážky“, „blíží se bouřka“ má COP používat
`POST /query` s mapovým `center`/`radiusM` nebo `bbox` a preferovat entity:

- `weather_forecast` ze `sourceSystem=weather_forecast`: plošná forecast buňka
  s `observedAt`, `validFrom`, `validUntil`, `handling` obsahujícím
  `dynamic_data_requires_timestamp`, detailním `providerProperties.display`
  a metrikami `precipitationNext10MinMm`, `precipitationNext1hMm`,
  `precipitationNext3hMm`, `precipitationProbabilityNext1hPercent`,
  `precipitationProbabilityNext3hPercent`, `thunderstormProbabilityPercent`,
  `windSpeedMps`, `windGustMps`, `maxWindGustNext6hMps` a `riskScore`.
  Primárním modelovým vstupem je Open-Meteo; při dočasném výpadku nebo
  rate-limitu SIM zachová stejný kontrakt a použije MET Norway
  Locationforecast. COP pozná fallback podle
  `providerProperties.weatherForecast.fallbackUsed=true`,
  `sourceInputs=["met_norway_locationforecast"]` a volitelného
  `providerProperties.weatherForecast.providerWarning`.
- `weather_radar`, `weather_nowcast`, `thunderstorm_risk` ze
  `sourceSystem=chmi_weather_radar`: radarová metadata ČHMÚ a raster overlay
  reference pro korelaci aktuálních srážek, nowcastu a bouřkového kontextu.
  SIM zatím neposkytuje redistribuovatelný raw feed blesků; entity proto nesou
  `metrics.lightningStrikeFeedAvailable=false` a
  `providerProperties.aiContext.lightningNearbyAvailable=false`.

`GET /observability` vrací top-level `status` jako dostupnost služby
search-data. Dílčí kvalita a čerstvost zdrojů je oddělená v
`dataQualityStatus`, `degradedSourceCount` a `sources[].dataQualityStatus`.
COP proto nemá top-level zdroj skrývat při `status=ok`, i když některé
`sources[]` hlásí `degraded`; má pouze zobrazit varování kvality pro konkrétní
zdroj.

COP má pro indexování používat primárně `GET /entities` se stránkováním přes
`nextCursor`. Pro interaktivní dotaz může použít `POST /query`, který vrací
rankované entity s důvody shody. SIM schválně nevrací raw upstream payloady jako
AI kontext; `rawRef` slouží jen jako omezená auditní reference.

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
- `diagnostic.mobile.coverage` je diagnostická vrstva `mobile_coverage` ze zdroje `mobile_coverage_model`, `selectable=true`, ale `defaultVisible=false` a `audience=diagnostic`,
- `diagnostic.mobile.ctu_measurements` jsou diagnostická ČTÚ měření, `selectable=false`,
- `reference.infrastructure.communications` jsou referenční OSM věže, `defaultVisible=false` a `selectable=false`,
- `public.boundary.country`, `public.boundary.region`, `public.boundary.district`, `public.boundary.orp` jsou referenční boundary read-model vrstvy z lokálního OSM/PostGIS, ne z veřejného Overpassu,
- `public.weather.temperature_grid`, `public.weather.wind_field`, `public.weather.precipitation_grid`, `public.weather.humidity_grid`, `public.weather.pressure_grid`, `public.weather.radar_reflectivity`, `public.weather.radar_precipitation`, `public.weather.radar_nowcast`, `public.safety.thunderstorm_risk` a `public.safety.air_quality_grid` jsou katalogově připravené environment vrstvy; radarové vrstvy jsou raster overlay metadata, ne raw lightning feed,
- `public.weather.forecast_area` je finální plošná předpovědní vrstva SIM; COP má použít dodaný `symbolKey`, `riskLevel`, `detailUrl` a `charts[]`, ne vlastní odhad ikon nebo grafů,
- `public.traffic.transit` sdružuje veřejnou dopravu. Provider vrstva `traffic.spravazeleznic_trains` poskytuje polohy vlaků z mapy Správy železnic; SIM ji dotazuje server-side nejvýše jednou za 15 minut bez ohledu na počet uživatelů COP,
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

| Pole                 | Typ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Popis                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `featureId`          | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | stabilní identifikátor v rámci zdroje                       |
| `layerId`            | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | doporučené COM katalogové ID, např. `public.mobile.network` |
| `providerId`         | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | identifikátor providera, např. `sim.situation-data`         |
| `providerLayerId`    | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | lokální vrstva providera, např. `mobile_network`            |
| `layer`              | `weather`, `ground`, `mobile`, `mobile_network`, `mobile_coverage`, `traffic`, `warnings`, `weather_alerts`, `fire`, `flood`, `boundary_admin`, `boundary_country`, `boundary_region`, `boundary_district`, `boundary_orp`, `place_settlements`, `trail_routes`, `trail_poi`, `outdoor_webcams`, `air_quality`, `weather_temperature_grid`, `weather_wind_field`, `weather_precipitation_grid`, `weather_humidity_grid`, `weather_pressure_grid`, `weather_forecast_area`, `weather_radar_reflectivity`, `weather_radar_precipitation`, `weather_radar_nowcast`, `weather_thunderstorm_risk`, `weather_webcams`, `air_quality_grid` | mapová vrstva                                               |
| `category`           | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | detailnější typ objektu                                     |
| `label`              | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | lidsky čitelný název                                        |
| `labelLocalized`     | object, optional                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | lokalizované názvy, typicky `cs` a `en`                     |
| `summaryLocalized`   | object, optional                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | lokalizovaný stručný popis pro detail v COM                 |
| `sourceId`           | string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | poskytovatel v SIM registry                                 |
| `sourceName`         | string, optional                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | lidsky čitelný název zdroje/read-modelu                     |
| `observedAt`         | ISO datetime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | čas pozorování nebo publikace                               |
| `validFrom`          | ISO datetime, optional                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | začátek platnosti, pokud zdroj poskytuje                    |
| `validUntil`         | ISO datetime, optional                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | konec platnosti, pokud zdroj poskytuje                      |
| `updatedAt`          | ISO datetime, optional                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | čas poslední aktualizace read-modelu nebo upstream objektu  |
| `confidence`         | number 0-1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | kvalita / důvěra agregátu                                   |
| `stale`              | boolean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | zda je objekt starší než prahová hodnota                    |
| `severity`           | `info`, `advisory`, `warning`, `critical`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | priorita pro vizualizaci                                    |
| `license`            | object                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | licence a atribuce zdroje                                   |
| `metrics`            | object                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | číselné metriky vrstvy                                      |
| `providerProperties` | object                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | provider-native hodnoty pro detail a audit                  |
| `raw`                | object, optional                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | omezený původní payload pro ladění                          |

Boundary features ve vrstvách `boundary_country`, `boundary_region`, `boundary_district`, `boundary_orp` a `place_settlements` navíc nesou:

| Pole             | Typ     | Popis                                                               |
| ---------------- | ------- | ------------------------------------------------------------------- |
| `adminLevel`     | number  | OSM/RUIAN-like správní úroveň, aktuálně 2/4/6/7/8 podle read-modelu |
| `name`           | string  | název území                                                         |
| `code`           | string  | kód území, typicky ISO/ref/OSM fallback                             |
| `countryCode`    | string  | ISO alpha-2, pro ČR `CZ`                                            |
| `areaName`       | string  | název pro detail mapy                                               |
| `styleHint`      | string  | doporučený style profile, např. `boundary-region-v1`                |
| `iconHint`       | string  | `boundary` nebo `place`                                             |
| `readModel`      | boolean | `true`, jde o lokální PostGIS read-model                            |
| `sourceRevision` | string  | revize/import timestamp read-modelu                                 |

Trail features z `osm_postgis` jsou oddělené od krizových vrstev:

| Vrstva         | Geometrie                        | Popis                                                                                                     |
| -------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `trail_routes` | `LineString` / `MultiLineString` | pěší, turistické, cyklo a MTB trasy z OSM relation/line read-modelu                                       |
| `trail_poi`    | `Point`                          | ubytování, přístřešky, voda, občerstvení, doprava, servis/půjčovny a outdoor nouzové body; ne IZS stanice |

`trail_routes` navíc posílá `properties.providerProperties.trail`:

| Pole                                       | Typ              | Popis                                                                                                                                                                |
| ------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contractVersion`                          | string           | `sim-osm-trail-route-v1`                                                                                                                                             |
| `mode`                                     | string           | `hiking`, `walking`, `bicycle`, `mtb`                                                                                                                                |
| `routeMode`                                | string           | původní OSM `route`, např. `hiking`, `foot`, `bicycle`, `mtb`                                                                                                        |
| `network`                                  | string           | OSM síť, např. `nwn`, `rwn`, `lwn`, `ncn`, `rcn`, `lcn`                                                                                                              |
| `ref`, `operator`, `osmcSymbol`            | string, optional | značení a provozovatel, pokud jsou dostupné                                                                                                                          |
| `lengthKm`, `segmentCount`                 | number, optional | délka a počet segmentů v materializovaném read-modelu                                                                                                                |
| `geometryDetail`                           | string           | `full` nebo `generalized`; pro detailní turistickou navigaci preferovat `full`                                                                                       |
| `simplificationDegrees`, `generalizationM` | number           | použitá geometrická generalizace; pokud je `generalizationM > 0`, COP má při přiblížení vyžádat čerstvá data pro aktuální bbox a nepoužívat starší přehledovou cache |

`trail_poi` navíc posílá `properties.providerProperties.trailPoi`:

| Pole                                              | Typ              | Popis                                                                                                                                                                                                            |
| ------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contractVersion`                                 | string           | `sim-osm-trail-poi-v1`                                                                                                                                                                                           |
| `category`                                        | string           | `sleep`, `camp`, `shelter`, `water`, `food`, `repair`, `rental`, `transport`, `emergency`; `emergency` znamená outdoor nouzový bod, defibrilátor, nouzový telefon nebo záchranný bod, ne `police`/`fire_station` |
| `categoryLabelLocalized`                          | object           | český a anglický název kategorie                                                                                                                                                                                 |
| `openingHours`, `website`, `wheelchair`, `access` | string, optional | veřejné OSM atributy pro detail                                                                                                                                                                                  |
| `mayDisplayContact`                               | boolean          | vždy `false`; SIM nepublikuje přímé kontaktní údaje z OSM jako běžný mapový detail                                                                                                                               |

`outdoor_webcams` je samostatná vrstva pro Turistika / Outdoor:

| Vrstva            | COM layer                | Zdroj                  | Popis                                                                                    |
| ----------------- | ------------------------ | ---------------------- | ---------------------------------------------------------------------------------------- |
| `outdoor_webcams` | `public.outdoor.webcams` | `chmi_weather_webcams` | Kurátorované turistické a městské webkamery z ověřených originálních webů provozovatelů. |

Feature má `properties.category="outdoor_webcam"`,
`properties.styleHint="outdoor-webcam-point-v1"` a
`properties.providerProperties.camera.presentationGroup="outdoor"`. Stejně jako
u počasových kamer se obraz neposílá ve feature streamu. COP má detail načítat
přes `providerProperties.camera.detailUrl`. Pokud
`providerProperties.camera.snapshotAvailable=true`, COP smí zobrazit
`snapshotUrl`; volitelné `snapshotAvailability="origin_page_discovery"` znamená,
že SIM hledá a validuje obraz až po kliknutí na originální stránce
provozovatele. Pokud snapshot endpoint vrátí HTTP 404, COP má nabídnout otevření
`providerProperties.camera.providerPageUrl` / `providerPageUrl` originálního
provozovatele. Pokud `snapshotAvailable=false`, COP snapshot endpoint nevolá.
WebCamLive smí být v SIM pouze auditní discovery zdroj, ne runtime obrazová
proxy.

## Emergency routing support

SIM poskytuje pro COP server-side routovací výpočet nad Valhalla enginem s
lokálním OSM/PostGIS fallbackem. COP má ovládat zadání a vykreslit vrácené
GeoJSON features; algoritmus routingu, snap na komunikace, cache, limity,
stav backendu a kvalitu výpočtu řeší SIM.

Endpointy:

```http
GET /situation-data/api/v1/routing/profiles
POST /situation-data/api/v1/routing/route
POST /situation-data/api/v1/routing/alternatives
POST /situation-data/api/v1/routing/isochrone
POST /situation-data/api/v1/routing/nearest-access
```

`GET /routing/profiles` vrací kontrakt `sim-routing-profile-catalog-v1`,
profily a `backend.operationBackends`. V produkci má COP očekávat
`operationBackends.route=valhalla`, `alternatives=valhalla`,
`isochrone=valhalla` a `nearestAccess=valhalla`; pokud backend degraduje,
SIM vrátí ve stejném kontraktu fallback nebo prázdný výsledek s varováním.

Profily:

| `profileId`               | Použití                                               |
| ------------------------- | ----------------------------------------------------- |
| `car`                     | běžné osobní vozidlo                                  |
| `emergency_vehicle`       | zásahové vozidlo, výchozí pro COP emergency route     |
| `large_emergency_vehicle` | velké zásahové vozidlo s konzervativnější volbou cest |
| `offroad_4x4`             | terénní vozidlo, využívá i track/service cesty        |
| `walking`                 | běžná pěší trasa                                      |
| `evacuation_walking`      | pomalejší pěší evakuační profil                       |

Silniční profily přijímají dvojice bodů vzdálené až 800 km vzdušnou čarou,
aby SIM podporoval vnitrostátní trasy přes celou Českou republiku. Skutečné
pokrytí zůstává omezené aktivním Valhalla grafem; produkční graf pokrývá ČR a
75 km přeshraniční pásmo.

Minimální požadavek na trasu:

```json
{
  "profileId": "emergency_vehicle",
  "from": { "lon": 14.42, "lat": 50.08, "label": "Start" },
  "to": { "lon": 14.45, "lat": 50.1, "label": "Cíl" },
  "avoid": ["flood", "road_closure"],
  "alternatives": 2,
  "includeSteps": true,
  "includeElevationProfile": true,
  "includeWeatherOnRoute": true,
  "includeHazardsOnRoute": true,
  "includeTraffic": true
}
```

Pole `alternatives` znamená požadovaný počet variant včetně primární trasy:
`1` vrací pouze primární trasu, `2` primární trasu a jednu alternativu, `3`
primární trasu a dvě alternativy. Valhalla může podle topologie sítě vrátit
méně nativních alternativ, než je požadováno; SIM se v takovém případě pokusí
dopočítat odlišnou variantu penalizací primární geometrie přes Valhalla
`linear_cost_factors`. Pokud ani tak nevznikne dostatečně odlišná trasa, SIM
vrátí méně variant a přidá explicitní zprávu do `warnings[]`.

Odpověď `sim-routing-route-v1` obsahuje:

| Pole                                           | Popis                                                                                                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes[]`                                     | strukturované varianty tras včetně vzdálenosti, ETA, snap vzdáleností, kroků, kvality a dopravního dopadu                                                               |
| `features[]`                                   | hotové GeoJSON prvky pro mapu COP; primární trasa má `styleHint=routing-primary-v1`, alternativy `routing-alternative-v1`                                               |
| `traffic`                                      | souhrn dopravního kontextu z NDIC/ŘSD SRTI použitého při výpočtu a vyhodnocení trasy                                                                                    |
| `quality`                                      | mirror kvality primární trasy pro rychlý souhrn bez procházení `routes[0]`                                                                                              |
| `routes[].elevation`                           | souhrn výškového profilu konkrétní varianty: zdrojový stav, převýšení, ztráta výšky, minimum, maximum, počet vzorků a warningy                                          |
| `routes[].elevationProfile[]`                  | vzorky výškového profilu konkrétní varianty: vzdálenost po trase, souřadnice, výška a volitelný sklon                                                                   |
| `routes[].weatherOnRoute`                      | počasí v koridoru konkrétní varianty: zdrojový stav, shrnutí, segmenty/body a warningy                                                                                  |
| `routes[].hazardsOnRoute`                      | bezpečnostní položky v koridoru konkrétní varianty: povodně, požáry, weather alerts, safety warnings a dopravní incidenty s vazbou na vzdálenost po trase               |
| `routes[].traffic.incidentsOnRoute[]`          | dopravní události v koridoru trasy včetně vzdálenosti od trasy a vzdálenosti po trase                                                                                   |
| `routes[].traffic.delayPenaltySeconds`         | orientační penalizace ETA podle událostí v koridoru; nejde o měřenou FCD rychlost                                                                                       |
| `routes[].traffic.hardExclusionCandidateCount` | počet closure-like událostí, které by mohly znamenat tvrdou uzávěru, pokud je k dispozici přesné mapování na úsek                                                       |
| `routes[].traffic.hardExclusionApplied`        | boolean příznak, že route obsahuje SRTI hard exclusion aplikovanou v routovacím požadavku; snake_case alias `hard_exclusion_applied` je dočasně také vracen pro klienty |
| `routes[].quality.mode`                        | `engine_route`, pokud SIM použil Valhalla; `osm_graph`, pokud SIM použil lokální OSM graph; `direct_fallback`, pokud není routovací graf dostupný                       |
| `routes[].quality.engine`                      | `valhalla` nebo `osm-postgis-graph`; COP má tuto hodnotu zobrazit v diagnostice/detailu trasy                                                                           |
| `routes[].quality.confidence`                  | modelová důvěra; SIM ji sníží, pokud trasa vede přes aktuální dopravní události                                                                                         |
| `warnings[]`                                   | důvody degradace nebo omezení výpočtu                                                                                                                                   |

`POST /routing/alternatives` má stejný vstup jako `/routing/route`, ale vrací
1-3 varianty. `POST /routing/isochrone` přijímá `origin`,
`maxTravelTimeMinutes` a profil, vrací polygon dosahu. `POST
/routing/nearest-access` přijímá `point`, `profileId` a volitelný `radiusM`,
vrací nejbližší routovatelný přístupový bod.

Route analysis sekce jsou volitelné a aktivují se request flagy:

- `includeElevationProfile=true`: SIM požádá Valhallu o adaptivní
  `elevation_interval` vzorky. Krátké a pěší trasy dostanou jemnější profil,
  dlouhé trasy mají limitovaný počet vzorků, aby COP detail zůstal rychlý.
  Pokud Valhalla profil nevrátí, použije lokální DEM sampler, je-li
  nakonfigurovaný. Pokud není dostupný žádný zdroj, vrátí
  `routes[].elevation.sourceStatus=disabled|degraded` a warning.
- `includeWeatherOnRoute=true`: SIM načte zapnuté weather zdroje v koridoru
  trasy, vytvoří `weatherOnRoute.summary` a segmenty s `routeDistanceM`,
  `segmentStartM`, `segmentEndM` a metrikami počasí.
- `includeHazardsOnRoute=true`: SIM načte safety projekce v koridoru trasy a
  doplní také SRTI dopravní incidenty z `routes[].traffic.incidentsOnRoute[]`.
- `includeTraffic=true`: traffic blok je kvůli kompatibilitě vracený i bez
  flagu pro road profily; flag vyjadřuje, že COP detail chce traffic explicitně.

Analytická data jsou vždy route-level. COP má porovnávat varianty podle
`routes[]`; nesmí přebírat `weatherOnRoute`, `hazardsOnRoute` nebo
`elevationProfile` z primární trasy na alternativy. Pokud SIM konkrétní sekci
nemůže dodat, vrátí ji se `sourceStatus=disabled|degraded` a srozumitelným
`warnings[]`, ne tichým vynecháním u požadované sekce.

Preferovaný produkční backend je Valhalla (`ROUTING_ENGINE=auto|valhalla` s
`VALHALLA_BASE_URL`), která vrací `quality.mode=engine_route` a
`source.backend=valhalla` pro `/route` i `/alternatives`. Stejný backend SIM
používá pro `/isochrone` přes Valhalla isochrone API a pro
`/nearest-access` přes Valhalla locate API. Produkční pilot používá samostatný
server `valhalla.home.cz` dostupný pro SIM jako
`http://valhalla.home.cz:8002`; lokální Docker profil zůstává vývojová varianta
pro menší instalace. Pilotní server používá plné vstupy pro Českou republiku,
Německo, Polsko, Slovensko, Rakousko a Maďarsko, ale závazný routovací rozsah je
ČR plus 75 km, nikoli celé sousední státy. SIM posílá `radius` i stejně velký
`search_cutoff` a odmítá endpoint nebo nearest-access snap mimo svůj limit.
Mapová data jsou rebuildovatelný OSM/Geofabrik read-model pod ODbL.

SIM při Valhalla `/route` volání používá pokročilé navigační parametry, pokud
je backend podporuje:

- `date_time.type=1`, pokud COP pošle `departureTime`; SIM zachová lokální
  civilní čas requestu, aby se časové zákazy a budoucí traffic profily
  vyhodnocovaly v lokální časové zóně trasy.
- `directions_options.turn_lanes=true` pro lane guidance v `routes[].steps[]`.
- `linear_references=true` a `admin_crossings=true` pro lepší diagnostiku a
  budoucí vazbu dopravních/hazardních událostí na routovací úseky.
- `recostings[]` pro orientační citlivost ETA na alternativní rychlostní
  předpoklady; výsledek je v `routes[].navigation.recostings[]` a
  `routes[].quality.recostings[]`, pokud jej Valhalla vrátí.
- `avoid=["unpaved"|"bridge"|"tunnel"]` se propisuje do Valhalla costing
  options; hard excludes vyžadují na Valhalla serveru
  `service_limits.allow_hard_exclusions=true`.

SIM zároveň používá existující `traffic` zdroj `road_srti_lod` jako routing
kontext. Při silniční trase načte aktuální NDIC/ŘSD SRTI události v okolí
trasy, vyhodnotí je proti koridoru výsledné geometrie a vrátí je v
`incidentsOnRoute[]`. Pokud požadavek obsahuje `avoid=["road_closure"]`, SIM u
closure-like bodů v přímém předkoridoru pošle Valhalle `exclude_locations`; v
odpovědi je taková událost označená `action=hard_exclusion_applied`. Protože
SRTI LOD zatím poskytuje pro SIM převážně reprezentativní body, COP to má
zobrazit jako dopravní ovlivnění trasy, ne jako garantovanou úsekovou uzávěru.
Přesné tvrdé uzávěry vyžadují DATEX II lineární reference nebo mapování na
Valhalla edge IDs.

Pokud Valhalla není dostupná a je nakonfigurovaný OSM/PostGIS, SIM použije
lokální model `osm-postgis-graph-v1`: skládá lokální graf z `public.osm_roads`,
respektuje profil, základní access tagy, one-way směr a volitelné vyhýbání
`unpaved`, `tunnel`, `bridge` a připojí stejný SRTI dopravní kontext do
odpovědi. `flood` a `fire` jsou zatím v kontraktu vedeny jako plánovací
preference; jako tvrdé překážky se zapnou až po normalizaci hazardních geometrií
do routovacího grafu nebo Valhalla restriction pipeline. Pokud žádný routovací
backend není dostupný, SIM vrátí přímou
fallback geometrii s `quality.mode=direct_fallback`, aby COP mohl jasně ukázat,
že nejde o trasu po komunikacích.

COP má pro stav navigace číst `GET /situation-data/health/ready` a
`GET /situation-data/api/v1/observability`. Pole `routing.status=ok` /
`routingBackend.status=ok` znamená plně použitelný routing; hodnota `degraded`
znamená zobrazit výsledky s výstrahou a neslibovat přesné navigační instrukce.

Traffic features ve vrstvě `traffic` navíc nesou stabilní civilní atributy, pokud je zdroj poskytuje:

| Pole               | Typ    | Popis                                                                          |
| ------------------ | ------ | ------------------------------------------------------------------------------ |
| `transportMode`    | string | normalizovaný mód, např. `bus`, `tram`, `train`, `metro`, `trolleybus`, `road` |
| `routeShortName`   | string | krátké označení linky/trasy                                                    |
| `destination`      | string | cílová stanice/směr, pokud zdroj poskytuje                                     |
| `delaySeconds`     | number | zpoždění v sekundách                                                           |
| `vehicleId`        | string | stabilní identifikátor vozidla ve zdroji                                       |
| `tripId`           | string | identifikátor jízdy/spoje ve zdroji                                            |
| `occupancyStatus`  | string | normalizovaný GTFS occupancy status                                            |
| `occupancyPercent` | number | procentuální obsazenost, pokud zdroj poskytuje                                 |
| `operator`         | string | dopravce nebo systém, např. `PID`, `IDS JMK`, `NDIC/ŘSD`                       |
| `headingDeg`       | number | směr pohybu ve stupních                                                        |
| `speedMps`         | number | rychlost v m/s                                                                 |

COM má pro civilní UI používat tato plochá pole v `properties`. Provider-specific PID/GTFS/IDS JMK/SRTI data jsou určena pouze pro detail, audit a diagnostiku v `providerProperties`; COM nemá parsovat raw provider payload jako běžný zdroj významu.

Coverage features ve vrstvě `mobile_coverage` navíc nesou:

| Pole                 | Typ                                       | Popis                                                       |
| -------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `operator`           | string                                    | zatím `unknown`; připraveno pro pozdější operátorské vstupy |
| `technology`         | `2G`, `4G`, `5G`                          | modelovaná technologie                                      |
| `quality`            | `good`, `fair`, `weak`, `none`, `unknown` | normalizovaná kvalita odhadu                                |
| `estimatedSignalDbm` | number                                    | orientační odhad RSSI/RSRP v dBm podle fáze modelu          |
| `modelVersion`       | string                                    | verze modelu, např. `coverage-v1`                           |
| `generatedAt`        | ISO datetime                              | čas výpočtu cached výsledku                                 |
| `resolutionM`        | number                                    | efektivní grid/polygon rozlišení v metrech                  |
| `demSource`          | string                                    | použitý DEM zdroj nebo `not-used-phase-1`                   |
| `assumptions`        | object                                    | použitý výškový/path-loss/terrain režim                     |
| `disclaimer`         | string                                    | upozornění, že nejde o garantované pokrytí operátora        |

Pro vykreslení `mobile_coverage` má COP použít `properties.providerProperties.display`:
`renderer=mobile_coverage_grid_cell_v1`, `style.fillColor`, `style.fillOpacity`,
`label`, `primaryValue`, `secondaryValue` a `legend`. Feature zároveň nese
`rendering.mode=feature`, `rendering.geometryRole=grid_cell`,
`styleHint=mobile-coverage-diagnostic-v1` a `tags.renderAs=coverage_grid_cell`.
COP nemá pro tuto vrstvu ignorovat geometrii jen proto, že `role=diagnostic`;
má ji skrýt v běžném veřejném zobrazení a zobrazit pouze po explicitním zapnutí
diagnostiky/ladění.

Unified mobile-network features ve vrstvě `mobile_network` navíc nesou:

| Pole                 | Typ                                                                    | Popis                                                                                                               |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `operator`           | `aggregate`, `unknown`                                                 | `aggregate` znamená souhrnný odhad bez operátorských stavových dat                                                  |
| `technology`         | `2G`, `4G`, `5G`, `mixed`, `unknown`                                   | dominantní / filtrovaná technologie výsledku                                                                        |
| `quality`            | `good`, `fair`, `weak`, `none`, `unknown`                              | normalizovaný závěr pro COM                                                                                         |
| `status`             | `ok`, `weak_signal`, `degraded_possible`, `outage_reported`, `unknown` | stavový závěr; bez partnerského feedu nejde o potvrzený výpadek BTS                                                 |
| `basis`              | string[]                                                               | vstupy, ze kterých byl závěr složen, např. `CTU_NETTEST_MEASUREMENT`, `INFERRED_COVERAGE`, `NO_OPERATOR_BTS_STATUS` |
| `summary`            | string                                                                 | krátké české shrnutí pro detail v COM                                                                               |
| `notices`            | string[]                                                               | bezpečnostní a kvalitativní poznámky k interpretaci                                                                 |
| `estimatedSignalDbm` | number                                                                 | orientační odhad podle modelu a měření                                                                              |
| `modelVersion`       | string                                                                 | verze sjednocujícího modelu                                                                                         |
| `disclaimer`         | string                                                                 | upozornění, že nejde o garantované pokrytí ani potvrzený stav konkrétní BTS                                         |

## Podporované zdroje

| Source                     | Vrstvy                                                                                                                                           | Popis                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open_meteo`               | `weather`                                                                                                                                        | Obecné počasí u středu bbox, silně cacheované podle weather gridu.                                                                                                                                                                                                                                                                       |
| `weather_forecast`         | `weather_forecast_area`                                                                                                                          | SIM-normalizované plošné předpovědi z modelových zdrojů: polygon, symbol, riziko, hlavní metriky a detailní meteogram endpoint. COP používá katalogovou vrstvu `public.weather.forecast_area`.                                                                                                                                           |
| `aviation_weather`         | `weather`                                                                                                                                        | NOAA AWC METAR/TAF pro letiště v bbox. SIM dotazuje AWC cacheovaně; COM AWC nevolá přímo.                                                                                                                                                                                                                                                |
| `chmi_weather_stations`    | `weather`                                                                                                                                        | Měřené meteorologické stanice ČHMÚ z `meteorology/climate/now`: teplota, vlhkost, tlak, vítr, srážky a sluneční svit. COM používá katalogovou vrstvu `public.weather.observations`.                                                                                                                                                      |
| `chmi_weather_radar`       | `weather_radar_reflectivity`, `weather_radar_precipitation`, `weather_radar_nowcast`, `weather_thunderstorm_risk`                                | Radarové kompozity ČHMÚ z `meteorology/weather/radar/composite`: aktuální MAX_Z, PseudoCAPPI 2 km, MERGE 1h a nowcast archivy. COM používá katalogové vrstvy `public.weather.radar_reflectivity`, `public.weather.radar_precipitation`, `public.weather.radar_nowcast`, `public.safety.thunderstorm_risk`. Neobsahuje raw polohy blesků. |
| `chmi_weather_webcams`     | `weather_webcams`, `outdoor_webcams`                                                                                                             | Veřejné kamery. Počasové kamery zůstávají ve vrstvě `public.weather.webcams`; kurátorované turistické/origin kamery jsou ve vrstvě `public.outdoor.webcams`.                                                                                                                                                                             |
| `chmi_air_quality`         | `air_quality`                                                                                                                                    | Měřené imisní stanice ČHMÚ z `air_quality/now`: index kvality ovzduší a hlavní polutanty. COM používá katalogovou vrstvu `public.safety.air_quality`.                                                                                                                                                                                    |
| `ctu_nettest`              | `mobile`                                                                                                                                         | ČTÚ NetTest otevřený export mobilních měření.                                                                                                                                                                                                                                                                                            |
| `ctu_stationary_mobile`    | `mobile`                                                                                                                                         | Oficiální stacionární měření mobilního signálu ČTÚ 2G/4G po operátorech. Historický diagnostický vstup, ne aktuální BTS stav.                                                                                                                                                                                                            |
| `mobile_coverage_model`    | `mobile_coverage`                                                                                                                                | SIM odhad mobilního pokrytí nad importovanými OSM věžemi. Publikuje polygonový grid s kvalitou `good/fair/weak/none/unknown`.                                                                                                                                                                                                            |
| `mobile_network_model`     | `mobile_network`                                                                                                                                 | Sjednocený výstup pro COM. Kombinuje modelované coverage, ČTÚ NetTest měření, stacionární měření ČTÚ a dostupné infrastrukturní indicie do jednoho závěru s `quality`, `status`, `confidence`, `basis` a `summary`.                                                                                                                      |
| `community_context`        | `community_places`                                                                                                                               | Praktický komunitní/outdoor kontext z lokálního OSM/PostGIS read-modelu: WC, voda, sprchy, nabíjení, AED, lékárny, přístřeší, knihovny, úřady a podobné civilní body.                                                                                                                                                                    |
| `pid_gtfs_rt`              | `traffic`                                                                                                                                        | PID/Golemio GTFS-RT vozidla pro dopravní kontext.                                                                                                                                                                                                                                                                                        |
| `idsjmk_vehicle_positions` | `traffic`                                                                                                                                        | Volitelný IDS JMK/Brno open-data zdroj poloh vozidel. SIM drží feed cache a publikuje pouze bbox-filtered features.                                                                                                                                                                                                                      |
| `spravazeleznic_trains`    | `traffic`                                                                                                                                        | Volitelný zdroj aktuálních poloh vlaků z veřejné mapy Správy železnic. SIM drží jednu server-side cache položku s minimálním TTL 900 s a do COP posílá normalizovaný GeoJSON ve WGS84.                                                                                                                                                   |
| `road_srti_lod`            | `traffic`                                                                                                                                        | NDIC/ŘSD SRTI dopravní události přes TamTam Research Linked Open Data SPARQL. SIM dotazuje upstream po TTL a COM používá pouze SIM odpověď.                                                                                                                                                                                              |
| `safety_data`              | `warnings`, `weather_alerts`, `fire`, `flood`, `boundary_admin`                                                                                  | Kompatibilní projekce Safety Data API do situačního kontraktu. Primární safety katalog je `sim.safety-data`; tato projekce slouží pro starší serverové adaptéry.                                                                                                                                                                         |
| `ardos_partner`            | `ground`, `mobile`, `traffic`                                                                                                                    | Neveřejný partnerský ARDOS zdroj. Vyžaduje `ARDOS_PARTNER_BASE_URL` a `ARDOS_PARTNER_TOKEN`.                                                                                                                                                                                                                                             |
| `osm_postgis`              | `ground`, `mobile`, `boundary_country`, `boundary_region`, `boundary_district`, `boundary_orp`, `place_settlements`, `trail_routes`, `trail_poi` | OpenStreetMap extract v PostGIS. Preferovaně HA PostgreSQL/Patroni přes `haproxy.home.cz:5000`; lokální Docker PostGIS jen jako rebuildovatelný read-model/cache.                                                                                                                                                                        |
| `osm_overpass`             | `ground`, `mobile`                                                                                                                               | Jen omezený vývoj/pilot; veřejný Overpass nesmí být runtime backend pro tisíce uživatelů.                                                                                                                                                                                                                                                |

## OpenStreetMap PostGIS

`osm_postgis` vrací referenční OSM objekty jako bodové features:

- `layer=ground`: nemocnice, lékárny, policie, hasičské stanice, ambulantní stanice, kryty, obecní úřady a vybrané nouzové body,
- `layer=mobile`: komunikační věže a mobilní infrastruktura odvozená z OSM tagů,
- `sourceId=osm_postgis`, licence `ODbL 1.0`, atribuce `OpenStreetMap contributors`.

Zároveň vrací administrativní hranice z materializovaného pohledu `public.osm_admin_boundary`:

- `boundary_country`: stát (`admin_level=2`),
- `boundary_region`: kraje (`admin_level=4`),
- `boundary_district`: okresy (`admin_level=6`),
- `boundary_orp`: ORP, pokud jsou dostupné (`admin_level=7`),
- `place_settlements`: sídla / obecní hranice (`admin_level=8`).

A outdoor/trail kontext z materializovaných pohledů:

- `trail_routes`: `public.osm_trail_routes`, OSM `route=hiking|foot|bicycle|mtb`,
- `trail_poi`: `public.osm_trail_poi`, normalizované body `sleep|camp|shelter|water|food|repair|rental|transport|emergency`; hasičské, policejní a zdravotnické stanice zůstávají v infrastrukturních vrstvách `ground`, ne v outdoor vrstvě.

Dotaz:

```http
GET /features?bbox=12.0,48.5,19.0,51.2&layers=boundary_country,boundary_region&source=osm_postgis&limit=250
GET /features?bbox=14.0,49.7,15.0,50.4&layers=trail_routes,trail_poi&source=osm_postgis&limit=1000
```

Konfigurace:

```env
OSM_POSTGIS_DATABASE_URL=postgresql://sim_osm:<strong-password>@haproxy.home.cz:5000/sim_osm
OSM_POSTGIS_TABLE=public.osm_poi
OSM_POSTGIS_ADMIN_BOUNDARY_TABLE=public.osm_admin_boundary
OSM_POSTGIS_TRAIL_ROUTES_TABLE=public.osm_trail_routes
OSM_POSTGIS_TRAIL_POI_TABLE=public.osm_trail_poi
SITUATION_DATA_OSM_POSTGIS_CACHE_TTL_SECONDS=21600
```

COM má tento zdroj používat stejně jako ostatní situační features. Nejde o autoritativní registr IZS; je to referenční kontext pro mapu. Veřejný Overpass endpoint zůstává pouze vývojová záloha.

Health `/situation-data/health/ready` u `osm_postgis` vrací `sourceHealth` s `backend`, `objectCount`, `lastImportAt`, `lastImportAgeSeconds`, `boundaryFeatureCount`, `boundaryLevels`, `boundaryLastImportAt`, `boundaryLastImportAgeSeconds`, `trailRouteFeatureCount`, `trailPoiFeatureCount`, `trailLastImportAt` a `trailLastImportAgeSeconds`. Metrics obsahují `situation_data_osm_postgis_objects`, `situation_data_boundary_read_model_features`, `situation_data_osm_trail_route_features`, `situation_data_osm_trail_poi_features`, import-age metriky a cache metriky `situation_data_source_cache_hits/misses{source="osm_postgis"}`.

## Community Context

`community_context` je samostatný SIM zdroj nad stejným lokálním OSM/PostGIS read-modelem jako `osm_postgis`. Je určený pro COP submenu `Turistika / Outdoor`, nikoli pro krizový prioritní pruh. Aktivní produkční vrstva je:

- provider layer `outdoor.community.places`,
- doporučené COP layer ID `public.outdoor.community_places`,
- SIM query `layers=community_places&source=community_context`,
- geometrie `Point`,
- `styleHint=community-place-osm-v1`,
- `sourceAuthority=reference`,
- `communityStatus=reference_only`.

Kategorie:

```text
toilet, drinking_water, water_point, shower, charging, fuel,
bicycle_repair, internet_access, public_library, community_centre,
municipal_office, pharmacy, defibrillator, shelter, assembly_point
```

Každá feature nese `providerProperties.community`:

| Pole                                                                | Význam                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `contractVersion`                                                   | `sim-community-context-v1`                                         |
| `placeId`                                                           | stabilní SIM identifikátor bodu                                    |
| `sourceAuthority`                                                   | nyní `reference`; nejde o potvrzený aktuální stav                  |
| `communityStatus`                                                   | nyní `reference_only`                                              |
| `category`, `rawCategory`, `categoryGroup`                          | normalizace pro ikony, filtry a detail                             |
| `categoryLabelLocalized.cs/en`                                      | hotové texty pro COP UI                                            |
| `openingHours`, `access`, `wheelchair`, `fee`, `payment`, `website` | veřejně zobrazitelné hodnoty z OSM, pokud existují                 |
| `canAcceptContributions`                                            | `true`; COP může nabídnout nahlášení stavu, fotku nebo návrh změny |
| `acceptedContributionTypes`                                         | `photo`, `review`, `status_report`, `proposed_edit`                |
| `proofOfVisitRecommended`                                           | doporučení pro budoucí ověření návštěvy                            |
| `moderationRequired`                                                | uživatelský obsah musí projít moderací před publikací jako ověřený |
| `mayDisplayContact`                                                 | `false`; SIM nepředává osobní kontakty z OSM do veřejného detailu  |

COP má pro první fázi zobrazit tyto body jako referenční civilní kontext a v detailu jasně uvést, že dostupnost není ověřený aktuální stav. Uživatelské fotky, recenze, hlášení a návrhy změn jsou budoucí navazující workflow: COP řeší formuláře, Keycloak identitu, fotky, Proof-of-Visit, anti-abuse a moderaci; SIM bude po schválení publikovat normalizovaný výstup jako `community_reports` nebo aktualizovaný komunitní stav.

Rezervovaná katalogová vrstva `outdoor.community.reports` / `public.outdoor.community_reports` je zatím `selectable=false`. COP ji nemá běžnému uživateli zapínat, dokud nebude hotový ingest a retenční/moderační pravidla.

## Weather a ČHMÚ Open Data

SIM publikuje bodové aktuální počasí a cacheované ČHMÚ vrstvy:

- `public.weather.current` / provider layer `weather.open_meteo`: bodový souhrn pro střed bbox. COP pro tuto vrstvu dál používá `layers=weather&source=open_meteo`; SIM server-side používá Open-Meteo jako primární zdroj a MET Norway Locationforecast jako druhý model/fallback v `providerProperties.weatherCorroboration`. Není to plošná vrstva. Pro plošné počasové overlaye používej `public.weather.temperature_grid`, `public.weather.wind_field`, `public.weather.precipitation_grid`, `public.weather.humidity_grid` a `public.weather.pressure_grid`.
- `public.weather.forecast_area` / provider layer `weather.forecast_area`: plošné předpovědní polygony ze zdroje `weather_forecast`. SIM je vrací jako stabilní WGS84 grid v českém operačním forecast coverage prostoru; mimo tento prostor nevrací viewportový fallback ani syntetické polygony. Každá feature nese `providerProperties.presentation.symbolKey`, `conditionLabel`, `riskLevel`, `colorRamp`, `metrics.riskScore`, `metrics.precipitationNext3hMm`, `metrics.precipitationProbabilityNext3hPercent`, `metrics.windSpeedMps`, `metrics.windGustMps`, `providerProperties.display.detailUrl/chartUrl`, `providerProperties.weatherForecast.detailUrl`, `providerProperties.weatherForecast.coverageBbox`, `providerProperties.weatherForecast.stableGrid`, `providerProperties.weatherForecast.sourceInputs` a při použití záložního modelu také `providerProperties.weatherForecast.fallbackUsed=true`. COP nemá z `weatherCode` sám odvozovat ikonu; má vykreslit dodaný `symbolKey` a barvit polygon podle `riskScore`/`riskLevel`.
- Detail předpovědní oblasti je `GET /situation-data/api/v1/weather-forecast/areas/{areaId}?bbox=west,south,east,north&hours=48&days=7`. Vrací `contractVersion=sim-weather-forecast-area-detail-v1`, `summary`, `current`, `nowcast.points`, `hourly.points`, `daily.points` a hotové `charts[]` pro teplotu, srážky, vítr a riziko. COP má grafy pouze vykreslit podle `charts[].series[].points`.
- `public.weather.observations` / provider layer `weather.chmi_station_observations`: bodové features meteorologických stanic s metrikami `temperatureC`, `relativeHumidityPercent`, `pressureHpa`, `windSpeedMps`, `windGustMps`, `windDirectionDeg`, `precipitation10mMm`, `sunshineDurationSeconds`, `elevationM`.
- ČHMÚ 10min station feed neposkytuje pro každou feature autoritativní stav oblohy typu `jasno/polojasno/oblačno`. SIM proto u `weather.chmi_station_observations` posílá explicitní prezentační hint `providerProperties.weather.symbolKey`, `providerProperties.weather.conditionLabel`, `providerProperties.weather.conditionMode`, `providerProperties.weather.authoritativeCondition`, `providerProperties.weather.confidence`, `providerProperties.weather.sourceInputs` a `providerProperties.presentation.mapLabel`. COP má tyto hodnoty použít před vlastní inferencí a nesmí při chybějící oblačnosti automaticky zobrazit `polojasno`.
- Pro mapové zobrazení má COP primárně používat `providerProperties.display`. Tento objekt je připravený k vykreslení: `iconKey`, `iconSet`, `label`, `subtitle`, `badgeLabel`, `badgeTone`, `primaryValue`, `secondaryValue`, `tertiaryValue`, `conditionMode`, `confidencePercent`, `detailUrl` a `chartUrl`. COP z něj nemá znovu dopočítávat stav počasí.
- SIM k 10min hodnotám doplňuje dostupné hodinové ČHMÚ `1h-*` prvky `ww`, `N`, `VV`, `SRA1H`, `SSV1H` a vybrané ceilometrové prvky. V metrikách se objevují například `presentWeatherCode`, `normalizedPresentWeatherCode`, `cloudCoverOctas`, `cloudCoverPercent`, `visibilityCode`, `precipitation1hMm`, `sunshineDuration1hTenths` a `sunshineDuration1hSeconds`.
- Konzervativní mapování SIM: hodinový `ww` má přednost pro déšť, sníh, bouřku, mlhu nebo zhoršenou dohlednost větrem (`conditionMode=observed`); naměřené srážky dávají `rain` nebo při nízké teplotě `snow` (`conditionMode=measured`); nízká dohlednost s vlhkostí nebo velmi vysoká vlhkost se slabým větrem dávají nízkodůvěrové `fog` (`conditionMode=estimated`); silný naměřený vítr dává `wind` (`conditionMode=measured`); hodinové `N` dává `sun`, `partly_cloudy` nebo `cloud` (`conditionMode=observed`); měřený sluneční svit bez hodinové oblačnosti dává `sun` nebo `partly_cloudy` jako odhad (`conditionMode=estimated`). Jinak je symbol `measurement`, label `měřené počasí` a `conditionMode=unclassified`.
- Detail stanice je provider-side endpoint `GET /weather-stations/{stationId}/detail?historyHours=48&forecastHours=24`. Vrací `contractVersion=sim-weather-station-detail-v1`, `current.display`, `history.points`, `forecast.points` a hotové `charts[]` pro teplotu, srážky, vítr a vlhkost/oblačnost. Historie vychází z ČHMÚ `10m-*` a `1h-*` souborů, předpověď z modelového Open-Meteo zdroje pro souřadnice stanice. COP má grafy pouze vykreslit podle `charts[].series[].points`.
- `public.safety.air_quality` / provider layer `air_quality.chmi_station_observations`: bodové features imisních stanic s metrikami `airQualityIndex`, `pm10UgM3`, `pm25UgM3`, `no2UgM3`, `noxUgM3`, `o3UgM3`, `so2UgM3`, `coUgM3`.
- Environment grid/field vrstvy jsou dostupné přes stejné bbox query jako station-backed read model. Každá feature nese `readModel=true`, `sourceRevision`, `resolutionM`, `basis` a `providerProperties.upstreamStationId`.
- `public.weather.radar_reflectivity` / provider layer `weather.radar_reflectivity`: georeferencované raster overlay metadata pro ČHMÚ MAX_Z PNG + doprovodný HDF5 odkaz.
- `public.weather.radar_precipitation` / provider layer `weather.radar_precipitation`: PseudoCAPPI 2 km a MERGE 1h radar-srážkový kontext.
- `public.weather.radar_nowcast` / provider layer `weather.radar_nowcast`: metadata TAR archivů ČHMÚ extrapolačních nowcast produktů pro +10 až +60 minut.
- `public.safety.thunderstorm_risk` / provider layer `weather.thunderstorm_risk`: radarový kontext bouřkových jader z MAX_Z masked + EchoTop HDF5. `providerProperties.lightningStrikeFeed=false`; nejde o raw feed blesků.

Dotazy:

```http
GET /features?bbox=14.0,49.8,14.8,50.3&layers=weather&source=chmi_weather_stations&limit=50
GET /weather-stations/0-20000-0-11518/detail?historyHours=48&forecastHours=24
GET /features?bbox=14.0,49.8,14.8,50.3&layers=weather_forecast_area&source=weather_forecast&limit=24
GET /situation-data/api/v1/weather-forecast/areas/{areaId}?bbox=14.0,49.8,14.25,50.05&hours=48&days=7
GET /features?bbox=14.0,49.8,14.8,50.3&layers=air_quality&source=chmi_air_quality&limit=50
GET /features?bbox=14.0,49.8,14.8,50.3&layers=weather_temperature_grid,weather_wind_field,weather_precipitation_grid,weather_humidity_grid,weather_pressure_grid&source=chmi_weather_stations&limit=250
GET /features?bbox=14.0,49.8,14.8,50.3&layers=air_quality_grid&source=chmi_air_quality&limit=250
GET /features?bbox=12.0,48.5,19.0,51.2&layers=weather_radar_reflectivity,weather_radar_precipitation,weather_radar_nowcast,weather_thunderstorm_risk&source=chmi_weather_radar&limit=20
GET /weather-radar/frames?product=merge1h&hours=6&limit=24
```

ČHMÚ zdroje jsou source-level cacheované. Výchozí TTL:

- `SITUATION_DATA_CHMI_WEATHER_CACHE_TTL_SECONDS=600`
- `SITUATION_DATA_CHMI_AIR_QUALITY_CACHE_TTL_SECONDS=900`
- `SITUATION_DATA_CHMI_WEATHER_RADAR_CACHE_TTL_SECONDS=300`
- `SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_HISTORY_HOURS=6`
- `SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_MAX_COUNT=72`
- `SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_STORE_ENABLED=false`
- `SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_STORE_DIR=/data/weather-radar-frames`
- `SITUATION_DATA_CHMI_WEATHER_RADAR_CLEAN_CROP_INSET_PIXELS=2`

COP nemá volat `opendata.chmi.cz` přímo. Má použít SIM provider catalog a bbox query.

## Lehký summary/detail kontrakt

Plný `GET /situation-data/api/v1/features` je mapový GeoJSON stream. Pro
seznamy, dashboardy, diagnostiku zdrojů a náhledy má COP používat:

```http
GET /situation-data/api/v1/features/summary?bbox=...&layers=weather,weather_webcams,air_quality&limit=250
```

Summary odpověď má `contractVersion=sim-provider-feature-summary-v1` a nevrací
souřadnice. Každá položka obsahuje `featureId`, `layerId`, `providerLayerId`,
`sourceId`, `label`, `severity`, `stale`, `confidence`, časovou platnost,
metriky, `rendering`, `geometrySummary` a odkazy `links.detail` a
`links.geometry`.

Pro oddálenou mapu a husté vrstvy má COP použít agregaci do stabilních WGS84
buněk:

```http
GET /situation-data/api/v1/features/density?bbox=...&layers=mobile_network,weather_temperature_grid&limit=1000&cellSizeDegrees=0.1
```

Density odpověď má `contractVersion=sim-provider-feature-density-v1`, nevrací
původní geometrie prvků a obsahuje pouze grid cell polygon, počty podle vrstev,
zdrojů a závažnosti, `topSeverity` a omezené `sampleFeatureIds` pro následný
drill-down přes `features/summary` nebo detail. Pokud `cellSizeDegrees` není
zadáno, SIM zvolí stabilní velikost buňky podle rozsahu bboxu. Parametry
`maxCells` a `sampleSize` omezují velikost odpovědi.

Po kliknutí na objekt má COP dotáhnout detail:

```http
GET /situation-data/api/v1/features/{featureId}?bbox=...&layers=...&source=...
```

Detail vrací `contractVersion=sim-provider-feature-detail-v1`, sanitizované
properties, lokalizace a provider metadata bez raw upstream payloadu. Pokud je
potřeba zvýraznit nebo vykreslit geometrii samostatně, použije se:

```http
GET /situation-data/api/v1/features/{featureId}/geometry?bbox=...&layers=...&source=...
```

Číselníky a rendering role jsou dostupné zde:

```http
GET /situation-data/api/v1/taxonomy
```

COP má respektovat `geometrySummary.geometryRole` a `properties.rendering`.
Zejména `raster_extent` je jen rozsah rastru a nesmí se vykreslovat jako běžný
vyplněný polygon.

Radarové features jsou polygonové metadata pro raster overlay, ne vektorová buňková analýza. Polygon v `geometry` je pouze rozsah rastru; klient ho nesmí vykreslovat jako běžný vyplněný polygon. Klíčová pole:

```json
{
  "properties": {
    "layerId": "public.weather.radar_reflectivity",
    "providerLayerId": "weather.radar_reflectivity",
    "sourceId": "chmi_weather_radar",
    "observedAt": "2026-06-04T21:20:00.000Z",
    "validUntil": "2026-06-04T21:35:00.000Z",
    "tags": {
      "geometryRole": "raster_extent",
      "renderAs": "raster_overlay",
      "doNotRenderGeometryFill": "true"
    },
    "rendering": {
      "mode": "raster_overlay",
      "geometryRole": "raster_extent",
      "doNotRenderGeometryFill": true,
      "fallbackPolicy": "hide_if_raster_overlay_unsupported"
    },
    "providerProperties": {
      "geometryRole": "raster_extent",
      "renderAs": "raster_overlay",
      "doNotRenderGeometryFill": true,
      "raster": {
        "url": "/api/v1/weather-radar/clean/maxz/pacz2gmaps3.z_max3d.YYYYMMDD.hhmm.0.png",
        "rawUrl": "https://opendata.chmi.cz/.../pacz2gmaps3.z_max3d.YYYYMMDD.hhmm.0.png",
        "archiveUrl": "https://opendata.chmi.cz/.../pacz2gmaps3.fct_z_max.YYYYMMDD.hhmm.ft60s10.tar",
        "contentType": "image/png",
        "projection": "EPSG:3857",
        "boundsWgs84": [11.267, 48.047, 19.624, 51.458],
        "sourceBoundsWgs84": [11.267, 48.047, 20.77, 52.167],
        "dataBoundsWgs84": [11.267, 48.047, 19.624, 51.458],
        "renderMode": "clean_image_overlay",
        "sourceImageMayContainFrame": true,
        "sourceImageMayContainEmbeddedLabels": true,
        "servedImageMayContainFrame": false,
        "servedImageMayContainEmbeddedLabels": false,
        "cleanRasterAvailable": true,
        "cleanMethod": "server_crop_to_data_bounds",
        "artifactPolicy": "sim_clean_crop_from_raw_chmi_png",
        "recommendedCropBoundsWgs84": [11.267, 48.047, 19.624, 51.458],
        "frameCatalogUrl": "/api/v1/weather-radar/frames?product=maxz"
      },
      "hdf5": {
        "url": "https://opendata.chmi.cz/.../T_PABV23_C_OKPR_YYYYMMDDhhmmss.hdf"
      },
      "colorScaleUrl": "https://opendata.chmi.cz/meteorology/weather/radar/scl/scl-dbzmmh.png",
      "lightningStrikeFeed": false
    }
  }
}
```

ČHMÚ radarové PNG produkty jsou raw framed rasters. Některé produkty obsahují zdrojový rám, šedé okraje nebo textový popisek přímo v obrázku, například název produktu `CZRAD - ... MERGE`. SIM proto publikuje jako primární `providerProperties.raster.url` vlastní clean endpoint `/api/v1/weather-radar/clean/{productId}/{fileName}`. Tento endpoint raw PNG server-side stáhne, detekuje skutečnou radarovou datovou oblast, ořízne titulkový pás, převede neutrální šedé/černé rámové pixely na transparentní pixely, uloží výsledek do lokální cache a vrací PNG bez zdrojového horního/vnějšího rámu. Raw upstream obrázek je ponechaný v `rawUrl`/`sourceUrl` pouze pro diagnostiku a audit.

Frame katalog pro časovou osu:

```http
GET /weather-radar/frames?product=maxz,merge1h&hours=6&limit=24
```

Odpověď:

```json
{
  "contractVersion": "sim-weather-radar-frames-v1",
  "providerId": "sim.situation-data",
  "sourceId": "chmi_weather_radar",
  "historyHours": 6,
  "frameStore": {
    "enabled": false,
    "mode": "metadata_only",
    "assetBasePath": "/api/v1/weather-radar/assets",
    "cleanAssetBasePath": "/api/v1/weather-radar/clean"
  },
  "rasterSemantics": {
    "projection": "EPSG:3857",
    "boundsWgs84": [11.267, 48.047, 20.77, 52.167],
    "dataBoundsWgs84": [11.267, 48.047, 19.624, 51.458],
    "sourceImageMayContainFrame": true,
    "sourceImageMayContainEmbeddedLabels": true,
    "cleanRasterAvailable": true,
    "cleanMethod": "server_crop_to_data_bounds",
    "cleanCropInsetPixels": 2
  },
  "products": [
    {
      "productId": "merge1h",
      "layer": "weather_radar_precipitation",
      "catalogLayerId": "public.weather.radar_precipitation",
      "frames": [
        {
          "observedAt": "2026-06-21T12:00:00.000Z",
          "sourceUrl": "https://opendata.chmi.cz/...",
          "cleanUrl": "/api/v1/weather-radar/clean/merge1h/pacz2gmaps3.merge.20260621.1200.60.png",
          "stored": false
        }
      ]
    }
  ],
  "warnings": []
}
```

Pokud je `SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_STORE_ENABLED=true`, SIM může materializovat raw frames na lokální filesystem a frame položky dostanou `stored=true` a `localUrl`. Clean frame se materializuje lazy při prvním požadavku na `cleanUrl`; následné požadavky už jdou z lokální cache.

Poznámka k bleskům: SIM aktuálně nezveřejňuje polohy blesků. Čistý veřejný redistribuovatelný raw lightning feed pro ČR není v SIM nakonfigurován; komunitní sítě typu Blitzortung mají omezení použití pro varování/rizikovou analýzu. Pokud vznikne partnerství/licence, přidá se samostatný source a vrstva s explicitním licenčním a kvalitativním režimem.

## Environment grid vrstvy

Katalog SIM nově nabízí plošné environment vrstvy pro civilní mapu:

| Katalogové ID                        | Provider layer                | Typ               | Vstup                                                          |
| ------------------------------------ | ----------------------------- | ----------------- | -------------------------------------------------------------- |
| `public.weather.temperature_grid`    | `weather.temperature_grid`    | `grid_field`      | ČHMÚ měřené stanice                                            |
| `public.weather.wind_field`          | `weather.wind_field`          | `vector_field`    | ČHMÚ měřené stanice                                            |
| `public.weather.precipitation_grid`  | `weather.precipitation_grid`  | `grid_field`      | ČHMÚ měřené stanice                                            |
| `public.weather.humidity_grid`       | `weather.humidity_grid`       | `grid_field`      | ČHMÚ měřené stanice                                            |
| `public.weather.pressure_grid`       | `weather.pressure_grid`       | `grid_field`      | ČHMÚ měřené stanice                                            |
| `public.weather.forecast_area`       | `weather.forecast_area`       | `vector_features` | SIM předpovědní agregát nad Open-Meteo s MET Norway fallbackem |
| `public.weather.radar_reflectivity`  | `weather.radar_reflectivity`  | `raster_overlay`  | ČHMÚ radar MAX_Z                                               |
| `public.weather.radar_precipitation` | `weather.radar_precipitation` | `raster_overlay`  | ČHMÚ PseudoCAPPI/MERGE                                         |
| `public.weather.radar_nowcast`       | `weather.radar_nowcast`       | `raster_overlay`  | ČHMÚ COTREC nowcast                                            |
| `public.safety.thunderstorm_risk`    | `weather.thunderstorm_risk`   | `raster_overlay`  | ČHMÚ MAX_Z masked/EchoTop, bez raw blesků                      |
| `public.safety.air_quality_grid`     | `air_quality.grid`            | `grid_field`      | ČHMÚ imisní stanice                                            |

V aktuální fázi SIM vrací grid jako GeoJSON features nad stabilní WGS84 buňkou. Hodnota buňky je odvozena z nejbližší měřené stanice uvnitř výřezu; nejde o meteorologický numerický model ani právně závaznou interpolaci. Feature proto nese `rendering.mode=grid_field`, `rendering.geometryRole=grid_cell`, `tags.renderAs=grid_field`, `providerProperties.valueMetric` a `metrics.value`. Srážkový grid je jednotkově `mm/10min`, protože vychází z metriky ČHMÚ `precipitation10mMm`. Materializované tile endpointy jsou další výkonová fáze pro velmi vysoký provoz.

Observability:

```http
GET /observability
```

Vrací sekce:

- `environmentGrid`: stav katalogovaných gridů, stabilní grid alignment a upstream health,
- `boundaryReadModel`: stav `public.osm_admin_boundary`, počet prvků, import age, levels.

## Mobile Coverage Model

`mobile_coverage_model` vrací modelované coverage polygony jako samostatnou vrstvu `mobile_coverage`. Je to technický/modelový vstup pro `mobile_network`, ne běžná občanská vrstva. COM ho má zobrazovat pouze v diagnostice nebo při ladění modelu.

Vrstva je modelový odhad:

- vstup: `public.osm_poi` z `osm_postgis`, kategorie `communications_tower`,
- výpočet: grid nad bbox, nejbližší věž, distance/path-loss odhad a pri `MOBILE_COVERAGE_TERRAIN_AWARE=true` DEM line-of-sight penalizace,
- technologie: `2G`, `4G`, `5G`,
- operator: `unknown`,
- DEM: Copernicus GLO-30 `copernicus-glo30-cz`; pokud je dostupný pro oblast, výstup nese `terrainApplied=true` a metriky `terrainPenaltyDb`, `terrainMaxObstructionM`, `terrainSamples`, `towerElevationM`, `targetElevationM`.

Dotaz:

```http
GET /cop/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_coverage&source=mobile_coverage_model&technology=4G&limit=250
```

Volitelné parametry:

- `technology` nebo `technologies`: comma-separated filtr `2G,4G,5G`,
- `operator` nebo `operators`: zatím podporuje pouze `unknown`,
- `limit`: počet polygonů po aplikaci bbox filtru.

Pokud bbox obsahuje více připravených grid buněk než `limit`, SIM vrací
prostorově deterministický vzorek rozložený přes požadovaný bbox. Odpověď tedy
nesmí tvořit kompaktní obdélník z jedné hrany území; při širokém bboxu jde o
mapový vzorek, ne kompletní raster. COP má pro detailnější vykreslení požádat o
menší bbox nebo vyšší limit a nemá vzorek geometricky posouvat ani doplňovat
vlastními dlaždicemi.

Metadata:

```http
GET /mobile-coverage/metadata
```

Interaktivni per-BTS viewshed pro detail po kliknuti na BTS:

```http
GET /mobile-coverage/towers/node:13743393126/viewshed?technology=4G&radiusM=12000&azimuthStepDeg=10&distanceStepM=500
```

COP nema viewshed URL skladat z `feature.id`. OSM komunikacni stožary z provider layeru
`mobile.osm_postgis.communications` nesou v `properties.providerProperties.mobileCoverage`
hotovy detailni kontrakt:

- `contractVersion=sim-mobile-coverage-tower-reference-v1`,
- `towerId` ve forme `node:<id>`, `way:<id>`, `relation:<id>` nebo `area:<id>`,
- `viewshedAvailable=true`,
- `viewshedUrl`, napr. `/situation-data/api/v1/mobile-coverage/towers/area:436954796/viewshed`,
- `defaultQuery` s doporucenymi hodnotami `technology=4G`, `radiusM=12000`, `azimuthStepDeg=10`,
  `distanceStepM=500`, `includeNoSignal=false`,
- `radiusMByTechnology` pro vychozi dosah `2G=25000`, `4G=12000`, `5G=5000`,
- `btsStatus=operator_feed_unavailable`, `operatorStatusAvailable=false`.

Pokud COP nema k dispozici `viewshedUrl`, smi pouzit `tags.viewshedTowerId`.
Kvuli lokalnimu OSM/PostGIS importu musi podporovat i `area:<id>`; nejde o chybu
ani o polygon k vykresleni, ale o stabilni OSM typ objektu v read modelu.

Odpoved je GeoJSON `FeatureCollection` s `contractVersion=sim-mobile-coverage-tower-viewshed-v1`. `features[]` jsou radialni sektorove polygony v layeru `mobile_coverage`, kategorii `mobile_coverage_viewshed`. Vychozi odpoved ma `query.includeNoSignal=false` a vraci pouze sektory, kde SIM odhaduje dosah (`quality=good|fair|weak`). Sektory `quality=none` nejsou v beznem operatorovem overlayi vraceny, aby COP nevykresloval zavadejici kruhovy terc. Pro diagnostiku muze COP explicitne volat `includeNoSignal=true` a zobrazit plnou radialni mrizku.

- COP ma primarne kreslit `properties.providerProperties.display.style` a nevymyslet vlastni barvy,
- barva podle `properties.quality`: `good`, `fair`, `weak`; `none` jen pri `includeNoSignal=true`,
- volitelna popiska/detail podle `properties.estimatedSignalDbm`,
- technicky detail podle `properties.metrics.terrainPenaltyDb`, `terrainMaxObstructionM`, `lineOfSightClear`, `distanceM`, `bearingDeg`,
- zdroj a omezeni podle `summary.disclaimer`, `tower.btsStatus`, `tower.operatorStatusAvailable`, `properties.assumptions`,
- souhrn stineni podle `summary.computedSectorCount`, `summary.omittedNoSignalSectorCount`, `summary.lineOfSightBlockedSectorCount`.

Viewshed endpoint je on-demand vypocet pro jednu vez. COM ho nema volat pro vsechny BTS naraz ani pouzivat jako beznou mapovou vrstvu. Pro normalni mapu zustava autoritativni vrstva `mobile_network`.

Viewshed je odhad terennem ovlivneneho radioveho dosahu. Neni to potvrzeny operacni stav BTS, operatorovy RF plan ani vypocet se sektorem anteny. SIM aktualne nema operatorovy live/NOC feed, sektorovy azimut, downtilt, EIRP ani frekvencni pasmo konkretni BTS. Pokud tyto vstupy pozdeji pribudou, SIM muze stejnou odpoved zpresnit bez toho, aby COP menil workflow.

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

`mobile_network_model` publikuje pouze geometrii připraveného coverage read-modelu (`readModel=true`). Pokud pro dotazovaný bbox nejsou dostupné coverage buňky read-modelu, endpoint vrací `0` features a warning. SIM v takové situaci nesmí syntetizovat polygon z dotazovaného bboxu ani vracet `mobile_network:aggregate:mixed:*`. Pokud jsou dostupná pouze měření ČTÚ, zůstávají jako bodové zdroje `ctu_nettest` nebo `ctu_stationary_mobile`; sjednocená veřejná plošná vrstva je z nich sama nevyrábí.

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

Konzistence technologie je závazná: dotaz filtrovaný na jednu technologii (`2G`, `4G`, `5G`) vrací jen read-model features této technologie. Hodnota `mixed` se nepoužívá jako skrytý fallback pro filtrovaný dotaz.

Bez autorizovaného operátorského/NOC feedu SIM nepublikuje potvrzený stav konkrétní BTS. Současný výstup je validovaný situační odhad pro občanské bezpečnostní zobrazení. SIM web v operačním centru zobrazuje tento stav v dialogu `BTS live status` a publikuje stažitelný návrh budoucího kontraktu pro operátorský/NOC feed jako `/docs/sim-bts-live-openapi.json`.

Health `/situation-data/health/ready` u `mobile_network_model` vrací `backend`, `objectCount` a závislé zdroje. `ctu_nettest` a `ctu_stationary_mobile` mají vlastní health položky s počtem měření a časem posledního měření. Metrics obsahují `situation_data_mobile_network_towers`, `situation_data_mobile_network_backend_info`, `situation_data_ctu_nettest_measurements`, `situation_data_ctu_stationary_mobile_measurements` a cache metriky `situation_data_source_cache_hits/misses{source="mobile_network_model"}`.

## Radio Planning

SIM poskytuje ad-hoc radio LoS sluzby pro COP nastroj `Radio LoS`. Nejsou to
trvale mapove vrstvy; COP je vola az po akci operatora.

Endpointy:

```http
GET /radio/profiles
POST /radio/profiles
POST /radio/link-check
POST /radio/coverage
POST /radio/site-search
```

`GET /radio/profiles` vraci vestavene profily pro PMR446, CB, radioamaterska
pasma, business VHF/UHF, TETRA generic, marine/aviation generic, LoRa/Wi-Fi
data linky a neklasifikovane genericke vojenske sablony. Vojenske profily
maji `sensitiveUse=true`, ale nesmi obsahovat klasifikovane nebo operacne
citlive parametry.

COP muze ulozit vlastni profil:

```json
{
  "profileId": "custom_team_radio",
  "name": "Tymove radio",
  "category": "business",
  "frequencyMhz": 170,
  "txPowerW": 10,
  "antennaHeightM": 4,
  "receiverHeightM": 1.5,
  "maxRadiusM": 12000
}
```

Rezimy:

- `POST /radio/coverage`: operator je v jednom bode a chce docasny GeoJSON
  prekryv pokryti,
- `POST /radio/link-check`: operator overuje spojeni mezi dvema body a COP muze
  vykreslit vyskovy profil z `profileSamples[]`,
- `POST /radio/site-search`: operator zada bbox a cilove body; SIM vrati
  serazene kandidatni body se `score`, `rank`, `visibleTargetCount`,
  `coveredTargetPct`, `meanLinkMarginDb` a `minFresnelClearanceM`.

COP musi u kazdeho vysledku zobrazit upozorneni, ze jde o modelovy odhad podle
DEM a zadanych parametru radia. Vystup nezahrnuje budovy, vegetaci, ruseni,
vytizeni pasma/site, sifrovani, realne operatorovy RF planovani ani
klasifikovane parametry.

SIM cacheuje normalizovane odpovedi `link-check`, `coverage` a `site-search`
podle radio profilu, souradnic, parametru vypoctu a DEM fingerprintu.
Vychozi runtime cache je `SITUATION_DATA_RADIO_PLANNING_CACHE_TTL_SECONDS=900`
a `SITUATION_DATA_RADIO_PLANNING_CACHE_MAX_ENTRIES=512`. COP muze bezpecne
opakovat stejny dotaz po otevreni detailu; SIM nemusi znovu spoustet DEM
sampling, dokud cache nevyprsi.

Podrobny kontrakt a priklady jsou v
[`../situation-data/05_RADIO_PLANNING_MODEL.md`](../situation-data/05_RADIO_PLANNING_MODEL.md).

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
- Default `limit=250`; API přijímá až `limit=5000` pro velké přehledy, ale
  COP má pro husté vrstvy preferovat menší bbox, zoom-based filtraci a
  clustering/decluttering.
- Layer tree a defaultní viditelnost řídit z `GET /catalog`, ne ze staršího `/sources`.
- Weather a traffic vrstvy zobrazovat jako kontext. `pid_gtfs_rt` obsahuje
  pohybující se vozidla veřejné dopravy a v detailu vozidla i oficiální
  GTFS-RT TripUpdates predikce, pokud je SIM pro daný spoj najde; nejsou to COM
  tracky ani letecké cíle.
- Veřejnou dopravu vykreslovat podle jednotného kontraktu
  [`16_PUBLIC_TRANSIT_CONTEXT_CONTRACT.md`](16_PUBLIC_TRANSIT_CONTEXT_CONTRACT.md);
  COP nemá volat PID/Golemio, IDS JMK ani jiné městské upstreamy přímo.
- `mobile_network` zobrazovat jako hlavní mobilní vrstvu s legendou kvality a upozorněním, že jde o odhad, ne potvrzený stav konkrétní BTS.
- `mobile_coverage` používat jen jako technický/detailní vstup, pokud je potřeba ladit model.
- `aviation_weather` zobrazovat jako letištní počasí, ne jako tracky.
- `ardos_partner` zobrazovat jen ve views, kde uživatel má oprávnění pro partnerská data.
- U každého objektu zobrazovat zdroj a licenci.
