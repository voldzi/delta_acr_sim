# Plán realizace Flight Data API

## Fáze 1: integrační základ

Stav: implementováno v první verzi.

- Samostatná služba `apps/flight-data-api`.
- Docker service `flight-data-api`.
- Veřejný proxy prefix v SIM webu: `/flight-data/`.
- Zdravotní endpointy a metriky.
- Provider rozhraní pro `mock`, `adsb_lol`, `opensky`.
- Deduplikace podle normalizovaného `icao24`.
- Referenční lookup letišť a typů letadel.
- COP projekce `/api/v1/cop/tracks`.
- OpenAPI dokument `docs/api/openapi-flight-data.yaml`.

## Fáze 2: datová kvalita

- Přidat import OurAirports CSV do persistentního úložiště.
- Přidat verzování referenčních dat a timestamp poslední synchronizace.
- Přidat úplnější aircraft type store z licencovaného zdroje.
- Doplnit airline/route enrichment pouze ze zdrojů s jasnou licencí.
- Přidat validaci rychlostí a geografických skoků pro live feedy.

## Fáze 3: COP integrace

- Přidat do COP nový datový zdroj `PUBLIC_FLIGHT_AGGREGATE`.
- Polling nebo server-side ingestion z `https://sim.zeleznalady.cz/flight-data/api/v1/cop/tracks`.
- V COP rozlišit zdroj tracku: SIM syntetika vs veřejný letový agregát.
- V mapě zobrazit `icao24`, callsign, typ letadla, rychlost, výšku a zdroj licence.
- Přidat stav zdroje: API OK, source warning, stale tracks, source unavailable.

## Fáze 4: komerční připravenost

- Rozhodnout finální live provider.
- Zajistit smlouvu nebo právní posouzení ODbL obligations.
- Přidat rate limiting, server-side cache a audit přístupů.
- Přidat explicitní atribuci zdrojů do COP UI a exportů.
- Přidat administraci zapnutých providerů a jejich licence.

## Konfigurace

Výchozí lokální a produkční režim je bezpečný:

```bash
FLIGHT_DATA_ENABLED_SOURCES=mock
```

Live ADSB.lol:

```bash
FLIGHT_DATA_ENABLED_SOURCES=adsb_lol
FLIGHT_DATA_DEFAULT_LAT=50.1008
FLIGHT_DATA_DEFAULT_LON=14.2632
FLIGHT_DATA_DEFAULT_RADIUS_NM=120
```

OpenSky jen po ověření oprávnění:

```bash
FLIGHT_DATA_ENABLED_SOURCES=opensky
OPENSKY_CLIENT_ID=...
OPENSKY_CLIENT_SECRET=...
```

Kombinovaný agregát:

```bash
FLIGHT_DATA_ENABLED_SOURCES=adsb_lol,opensky
```
