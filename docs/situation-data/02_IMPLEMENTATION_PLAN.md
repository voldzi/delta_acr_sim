# Implementační plán Situation Data API

## Fáze 1: Stabilní kontrakt a pilotní zdroje

1. Přidat službu `@delta-acr/situation-data-api` s health endpointy, registry zdrojů a COP GeoJSON kontraktem.
2. Implementovat vrstvy:
   - `mock`: stabilní testovací features pro ground/mobile/traffic/weather,
   - `open_meteo`: live weather feature pro střed bbox,
   - `osm_postgis`: PostGIS provider nad OpenStreetMap extractem pro produkční ground/mobile reference; preferovaně Patroni/PostGIS, lokální Docker DB pouze jako rebuildovatelný read-model/cache,
   - `osm_overpass`: volitelný live ground provider pro malé bbox dotazy,
   - `ctu_nettest`: live/periodický ČTÚ NetTest ZIP export pro mobilní měření,
   - `pid_gtfs_rt`: live PID/Golemio GTFS-RT vozidla pro dopravní kontext,
   - `aviation_weather`: NOAA AWC METAR/TAF letištní počasí,
   - `ardos_partner`: neveřejný partnerský vstup ARDOS pro interní COP pohledy.
3. Přidat endpointy:
   - `GET /api/v1/layers`
   - `GET /api/v1/sources`
   - `GET /api/v1/config`
   - `GET /api/v1/features`
   - `GET /api/v1/cop/features`
4. Přidat proxy do `sim-web`:
   - `/situation-data/api/`
   - `/situation-data/health/`
   - `/situation-data/metrics`
5. Doplnit panel v SIM pro dohled nad stavem sběru, zdroji, licencemi, počtem features, warnings a preview.
6. Doplnit server-side cache s in-flight deduplikací, stale-if-error fallbackem, LRU limitem, kanonickým bbox klíčem pro COP výřezy a source-level cache pro Open-Meteo, OSM/PostGIS, ČTÚ NetTest, PID GTFS-RT, Safety Data, Aviation Weather, ARDOS a volitelný Overpass.

## Fáze 2: Další síťové a dopravní vrstvy

1. Přidat ČTÚ DKAN metadata discovery, aby SIM uměla hlídat změnu URL/exportu a licence.
2. Přidat importní job pro OpenCellID nebo lokálně uložený výřez databáze buněk.
3. Přidat M-Lab agregace z BigQuery/exportů pro výkon sítě.
4. Přidat JSDI/NDIC/DATEX II konektor pro dopravní incidenty po potvrzení licence a způsobu přístupu.
5. Přidat PID GTFS-RT alerts jako samostatné dopravní incidenty.
6. Po ARDOS pilotu doplnit role/permissions v COP a oddělené veřejné vs interní zobrazení partnerských dat.

## Provozní zásady

- V každé feature musí být `sourceId`, licence, atribuce, `confidence`, `stale` a čas pozorování.
- Veřejné API nesmí vracet žádné API klíče ani interní tajemství.
- Public Overpass endpointy nepoužívat jako produkční runtime backend; pro vysoký provoz používat `osm_postgis` nad Patroni/PostGIS nebo lokálním rebuildovatelným OSM read-modelem.
- ČTÚ NetTest ZIP, PID GTFS-RT feed, Open-Meteo, Safety Data a případný Overpass se nesmí stahovat pro každý COP dotaz; SIM je drží ve source-level cache a sdílí probíhající fetch.
- SIM má při výpadku jednotlivého zdroje vracet dostupná data z ostatních zdrojů a `warnings`, ne 500 pro celý agregát.
