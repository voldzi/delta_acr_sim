# Plán realizace Flight Data API

## Fáze 1: integrační základ

Stav: implementováno v první verzi.

- Samostatná služba `apps/flight-data-api`.
- Docker service `flight-data-api`.
- Veřejný proxy prefix v SIM webu: `/flight-data/`.
- Zdravotní endpointy a metriky.
- Provider rozhraní pro `mock`, `adsb_lol`, `opensky`.
- Provider `local_adsb` pro vlastní readsb/dump1090 `aircraft.json` přijímače.
- Deduplikace podle normalizovaného `icao24`.
- Referenční lookup letišť a typů letadel.
- Cacheovaný OurAirports `airports.csv` import pro ČR a okolí s fallbackem na seed.
- Normalizované tracky `/api/v1/aircraft/positions`; kompatibilní projekce `/api/v1/cop/tracks`.
- Server-side cache s in-flight deduplikací, stale-if-error fallbackem, LRU limitem a cache metrikami.
- OpenAPI dokument `docs/api/openapi-flight-data.yaml`.

## Fáze 2: datová kvalita

- Přidat persistentní snapshot OurAirports CSV a administraci poslední synchronizace.
- Přidat verzování referenčních dat a timestamp poslední synchronizace.
- Přidat úplnější aircraft type store z licencovaného zdroje.
- Doplnit airline/route enrichment pouze ze zdrojů s jasnou licencí.
- Přidat validaci rychlostí a geografických skoků pro live feedy.

## Fáze 3: COM integrace

- Veřejný pilot `sim.zeleznalady.cz` je nakonfigurovaný na `FLIGHT_DATA_ENABLED_SOURCES=adsb_lol`.
- Přidat do COM nový datový zdroj `PUBLIC_FLIGHT_AGGREGATE`.
- Polling nebo server-side ingestion z `https://sim.zeleznalady.cz/flight-data/api/v1/aircraft/positions`.
- V COM rozlišit zdroj tracku: SIM syntetika vs veřejný letový agregát.
- V mapě zobrazit `icao24`, callsign, typ letadla, rychlost, výšku a zdroj licence.
- Přidat stav zdroje: API OK, source warning, stale tracks, source unavailable.

## Fáze 4: komerční připravenost

- Rozhodnout finální live provider.
- Zajistit smlouvu nebo právní posouzení ODbL obligations.
- Přidat rate limiting a audit přístupů.
- Přidat explicitní atribuci zdrojů do COM UI a exportů.
- Přidat administraci zapnutých providerů a jejich licence.

## Konfigurace

Výchozí lokální režim je bezpečný:

```bash
FLIGHT_DATA_ENABLED_SOURCES=mock
```

Live ADSB.lol pilot pro COM:

```bash
FLIGHT_DATA_ENABLED_SOURCES=adsb_lol
FLIGHT_DATA_DEFAULT_LAT=50.1008
FLIGHT_DATA_DEFAULT_LON=14.2632
FLIGHT_DATA_DEFAULT_RADIUS_NM=120
FLIGHT_DATA_CACHE_TTL_SECONDS=10
FLIGHT_DATA_STALE_IF_ERROR_SECONDS=60
FLIGHT_DATA_CACHE_MAX_ENTRIES=512
FLIGHT_DATA_STALE_AFTER_SECONDS=120
```

Vlastní ADS-B přijímače:

```bash
FLIGHT_DATA_ENABLED_SOURCES=local_adsb,adsb_lol
LOCAL_ADSB_AIRCRAFT_JSON_URLS=http://receiver-1.home.cz/tar1090/data/aircraft.json
FLIGHT_DATA_CACHE_TTL_SECONDS=5
```

OpenSky jen po ověření oprávnění:

```bash
FLIGHT_DATA_ENABLED_SOURCES=opensky
OPENSKY_CLIENT_ID=...
OPENSKY_CLIENT_SECRET=...
```

Kombinovaný agregát:

```bash
FLIGHT_DATA_ENABLED_SOURCES=local_adsb,adsb_lol
```
