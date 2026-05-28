# Implementační plán Situation Data API

## Fáze 1: Stabilní kontrakt a pilotní zdroje

1. Přidat službu `@csm-sim/situation-data-api` s health endpointy, registry zdrojů a COM GeoJSON provider kontraktem.
2. Implementovat vrstvy:
   - `mock`: stabilní testovací features pro ground/mobile/traffic/weather,
   - `open_meteo`: live weather feature pro střed bbox,
   - `osm_postgis`: PostGIS provider nad OpenStreetMap extractem pro produkční ground/mobile reference; preferovaně Patroni/PostGIS, lokální Docker DB pouze jako rebuildovatelný read-model/cache,
   - `osm_overpass`: volitelný live ground provider pro malé bbox dotazy,
   - `ctu_nettest`: live/periodický ČTÚ NetTest ZIP export pro mobilní měření,
   - `pid_gtfs_rt`: live PID/Golemio GTFS-RT vozidla pro dopravní kontext,
   - `aviation_weather`: NOAA AWC METAR/TAF letištní počasí,
   - `ardos_partner`: neveřejný partnerský vstup ARDOS pro interní COM pohledy.
3. Přidat endpointy:
   - `GET /api/v1/layers`
   - `GET /api/v1/sources`
   - `GET /api/v1/config`
   - `GET /api/v1/features`
   - `GET /api/v1/cop/features` jako kompatibilní alias pro aktuální backend adapter
4. Přidat proxy do `sim-web`:
   - `/situation-data/api/`
   - `/situation-data/health/`
   - `/situation-data/metrics`
5. Doplnit panel v SIM pro dohled nad stavem sběru, zdroji, licencemi, počtem features, warnings a preview.
6. Doplnit server-side cache s in-flight deduplikací, stale-if-error fallbackem, LRU limitem, kanonickým bbox klíčem pro COM výřezy a source-level cache pro Open-Meteo, OSM/PostGIS, ČTÚ NetTest, PID GTFS-RT, Safety Data, Aviation Weather, ARDOS a volitelný Overpass.

## Fáze 2: Normalizovaná doprava pro civilní UI

1. Doplnit normalizované dopravní atributy do všech veřejných `traffic` features:
   - `transportMode`,
   - `routeShortName`,
   - `destination`,
   - `delaySeconds`,
   - `vehicleId`,
   - `tripId`,
   - `occupancyStatus`,
   - `occupancyPercent`,
   - `operator`,
   - `headingDeg`,
   - `speedMps`.
2. Raw PID/GTFS/DATEX payloady ponechat pouze v `providerProperties`, aby COM nemusel parsovat provider-specific struktury.
3. Přidat JSDI/NDIC/DATEX II konektor pro dopravní incidenty po potvrzení licence a způsobu přístupu.
4. Přidat PID GTFS-RT alerts jako samostatné dopravní incidenty.

## Fáze 3: Civilní rizikové vrstvy pro COM

1. Doplnit katalogové vrstvy:
   - `public.safety.weather_alerts`,
   - `public.safety.fire`,
   - `public.safety.flood`,
   - `public.boundary.admin`.
2. Všechny features v těchto vrstvách musí nést stabilní pole:
   - `id`, `geometry`, `hazardType`, `severity`, `status`, `validFrom`, `validUntil`, `updatedAt`,
   - `source`, `sourceName`, `headline`, `description`, `recommendedAction`,
   - `confidence`, `certainty`, `urgency`, `areaName`, `adminLevel`,
   - `styleHint`, `iconHint`, `basis`.
3. Požáry publikovat jako hotový SIM produkt pro bbox query:
   - v ČR preferovat oficiální incidentové zdroje, pokud budou licenčně dostupné,
   - pro globální detekci použít NASA FIRMS VIIRS jako doplňkový satelitní zdroj,
   - nést `fireStatus`, `detectedAt`, `sourceSatellite` nebo `sourceIncident`, `confidence`, případně `intensity`/`frp`.
4. Povodně publikovat z cacheovaných hydrologických zdrojů:
   - `riverName`, `stationId`, `waterLevelCm`, `discharge`, `floodStage`, `trend`, `basin`, `affectedArea`.
5. Administrativní hranice publikovat ze stabilního lokálního/PostGIS read-modelu:
   - `adminLevel`, `name`, `code`, `countryCode`, `validFrom`, `source`,
   - používat zjednodušené geometrie podle zoomu.

## Fáze 4: Další síťové vrstvy a výkonové optimalizace

1. Přidat ČTÚ DKAN metadata discovery, aby SIM uměla hlídat změnu URL/exportu a licence.
2. Přidat importní job pro OpenCellID nebo lokálně uložený výřez databáze buněk.
3. Přidat M-Lab agregace z BigQuery/exportů pro výkon sítě.
4. Po ARDOS pilotu doplnit role/permissions v COM a oddělené veřejné vs interní zobrazení partnerských dat.
5. Doplnit tile endpointy, background refresh a Nginx/CDN cache pro velké polygonové vrstvy.

## Provozní zásady

- V každé feature musí být `sourceId`, licence, atribuce, `confidence`, `stale` a čas pozorování.
- Veřejné API nesmí vracet žádné API klíče ani interní tajemství.
- Public Overpass endpointy nepoužívat jako produkční runtime backend; pro vysoký provoz používat `osm_postgis` nad Patroni/PostGIS nebo lokálním rebuildovatelným OSM read-modelem.
- ČTÚ NetTest ZIP, PID GTFS-RT feed, Open-Meteo, Safety Data a případný Overpass se nesmí stahovat pro každý COM dotaz; SIM je drží ve source-level cache a sdílí probíhající fetch.
- SIM má při výpadku jednotlivého zdroje vracet dostupná data z ostatních zdrojů a `warnings`, ne 500 pro celý agregát.
