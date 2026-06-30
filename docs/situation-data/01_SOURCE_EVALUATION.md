# Vyhodnocení open-data zdrojů pro situační obraz

SIM má poskytovat COM doplňkové vrstvy, které rozšiřují vzdušný obraz o pozemní, síťový, dopravní a meteorologický kontext. Tyto vrstvy nejsou náhradou operačních systémů složek IZS ani garantovaným vojenským zdrojem. V pilotu slouží pro testování integrace, vizualizace a práce s kvalitou dat.

## Doporučené zdroje pro pilot

| Vrstva | Zdroj | Stav pro pilot | Licence / omezení |
| --- | --- | --- | --- |
| `weather` | Open-Meteo Forecast API | vhodné jako první live zdroj bez klíče | Free API je nekomerční, data pod CC BY 4.0 podmínkami, komerční použití přes placený tarif |
| `weather` | NOAA Aviation Weather Center METAR/TAF | implementováno jako `aviation_weather` pro letištní počasí | Veřejné API bez klíče, ale s rate limity; SIM musí cacheovat a COM nesmí volat AWC přímo |
| `ground` | OpenStreetMap přes OSM extract/PostGIS (`osm_postgis`); Overpass jen pro vývoj | implementováno jako PostGIS provider pro referenční POI po importu Geofabrik PBF extractu; produkčně preferovat Patroni/PostGIS, lokální Docker DB jen jako rebuildovatelný read-model/cache; veřejný Overpass pouze pro malé testovací bbox dotazy | ODbL 1.0, atribuce a share-alike povinnosti pro databáze; veřejné Overpass instance nejsou produkční runtime backend |
| `mobile` | ČTÚ NetTest open-data ZIP export | implementováno jako live/periodický zdroj `ctu_nettest`; vhodné pro kontext kvality mobilní sítě, ne pro real-time výpadky operátorů | CC BY 4.0 podle exportu; nutná atribuce a práce s anonymizací/accuracy |
| `traffic` | PID/Golemio GTFS-RT vehicle positions | implementováno jako live zdroj `pid_gtfs_rt` pro pohyb veřejné dopravy v Praze a okolí | open-data podmínky PID/Golemio; nutná atribuce, bez garance operační dostupnosti |
| `traffic` | Veřejné statické GTFS feedy | implementováno jako `public_transit_static`; výchozí ověřená sada je PID, IDS JMK, DPMO Olomouc a PMDP Plzeň; další města/regiony se přidávají konfiguračně přes `PUBLIC_TRANSIT_STATIC_GTFS_FEEDS` | statický zastávkový kontext, nikoli live poloha; SIM cacheuje ZIP server-side a COP nesmí volat upstream přímo |
| `traffic` | IDS JMK / Brno Open Data vehicle positions | implementováno jako volitelný zdroj `idsjmk_vehicle_positions`; zdrojová cache 20 s, COM nesmí volat upstream přímo | podmínky otevřených dat IDS JMK / Brno; endpoint může vyžadovat úpravu URL podle aktuální distribuce |
| `traffic` | Správa železnic mapa provozu vlaků | implementováno jako volitelný zdroj `spravazeleznic_trains`; SIM dekóduje mapový payload, převádí S-JTSK do WGS84 a drží jednu server-side cache pro celý feed | dohodnuté maximum načítání 1x za 15 minut; COM/COP nesmí volat upstream přímo a používá pouze normalizovaný GeoJSON ze SIM |
| `traffic` | NDIC/ŘSD SRTI Linked Open Data | implementováno jako `road_srti_lod`; SIM dotazuje SPARQL endpoint po TTL a bbox filtruje nad cache | dopravní události jako veřejný kontext, nutná atribuce ŘSD/NDIC a respektování provozních limitů endpointu |
| `ground/mobile/traffic` | ARDOS partner feed | implementováno jako vypnutý `ardos_partner` konektor | Není open-data; vyžaduje partnerskou dohodu, token, datovou minimalizaci a oprávnění uživatele v COM |
| `mobile` | OpenCellID, M-Lab | kandidáti pro další rozšíření | OpenCellID CC BY-SA 4.0; M-Lab CC0 |
| `traffic` | JSDI/NDIC/DATEX II | kandidát pro dopravní incidenty po potvrzení licence a způsobu přístupu | podmínky je nutné ověřit pro konkrétní distribuci a způsob odběru |

## Důležité omezení mobilní sítě

Veřejný real-time zdroj stavu BTS nebo aktuálních výpadků mobilních operátorů typicky neexistuje jako otevřený datový kanál. Pro pilot lze použít:

- historická/stacionární měření ČTÚ,
- pokrytí a deklarovanou dostupnost,
- OpenCellID jako hrubý registr buněk,
- M-Lab/ČTÚ-NetTest jako měření výkonu sítě,
- vlastní měřicí body, routery, modemy nebo telefony hlásící RSRP/RSRQ/SINR, latency a packet loss.

## Zdroje ověřené k 2026-05-20

- Open-Meteo Terms: https://open-meteo.com/en/terms
- Open-Meteo API docs: https://open-meteo.com/en/docs
- OpenStreetMap attribution/licence: https://osmfoundation.org/wiki/Licence/Attribution_Guidelines
- Overpass API: https://wiki.openstreetmap.org/wiki/Overpass_API
- ČTÚ Open Data API: https://data.ctu.gov.cz/api
- ČTÚ mobilní sítě: https://data.ctu.gov.cz/tags/mobilni-site
- ČTÚ NetTest dataset detail: https://data.ctu.gov.cz/dataset/nettest
- ČTÚ NetTest Open Data: https://nettest.ctu.gov.cz/en/Opendata
- PID/Golemio API docs: https://api.golemio.cz/pid/docs/openapi/
- IDS JMK / Brno Open Data katalog: https://data.brno.cz/
- TamTam Research SRTI LOD SPARQL endpoint: https://lod.tamtamresearch.com/sparql/
- TamTam Research LOD documentation: https://lod.tamtamresearch.com/docs/
- NOAA AWC Data API: https://aviationweather.gov/data/api/
- ARDOS / ARDOS partner network: https://radioklub.mo.gov.cz/ardos
- OpenCellID licence: https://wiki.opencellid.org/wiki/Licensing:
- M-Lab FAQ/licence: https://www.measurementlab.net/frequently-asked-questions/
- PID Open Data: https://pid.cz/o-systemu/opendata/
- Geofabrik Czech Republic OSM extract: https://download.geofabrik.de/europe/czech-republic.html
