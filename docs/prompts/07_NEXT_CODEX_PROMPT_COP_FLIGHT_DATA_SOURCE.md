# Prompt pro COP: integrace Flight Data API

Pokračuj v projektu COP a přidej nový zdroj dat pro veřejné/agregované lety letadel.

## Kontext

V projektu SIM byla přidána samostatná služba `flight-data-api`. Veřejný endpoint pro COP je:

```text
https://sim.zeleznalady.cz/flight-data/api/v1/cop/tracks
```

Lokálně v Docker síti:

```text
http://flight-data-api:4010/api/v1/cop/tracks
```

Autoritativní kontrakt:

```text
/Users/voldzi/Documents/Development/18 2026/DELTA_ACR/02 SIM/docs/integration/08_FLIGHT_DATA_SOURCE_CONTRACT.md
```

OpenAPI:

```text
/Users/voldzi/Documents/Development/18 2026/DELTA_ACR/02 SIM/docs/api/openapi-flight-data.yaml
```

## Úkol v COP

1. Přidej nový source typ `PUBLIC_FLIGHT_AGGREGATE`.
2. Přidej klienta pro `GET /flight-data/api/v1/cop/tracks`.
3. Tracky mapuj podle `trackId`, `icao24`, `lat`, `lon`, `altitudeM`, `speedMps`, `headingDeg`, `lastSeenAt`, `aircraft`, `quality`, `sources`.
4. V UI odliš SIM syntetické tracky od veřejných letových tracků.
5. Zobraz stav zdroje: OK, degraded podle `warnings`, stale podle `quality.stale`, unavailable při chybě API.
6. V detailu tracku zobraz `icao24`, callsign, registraci, typ letadla, zdroj a licenci.
7. Nepřepisuj existující SIM ingest; nový zdroj musí být vedlejší vrstva.

## Akceptační kritéria

- COP umí zapnout/vypnout vrstvu veřejných letů.
- COP při dostupném endpointu zobrazí reálné ADSB.lol tracky z `flight-data-api`; lokální vývoj může používat `mock`.
- COP deduplikuje historii podle `trackId`.
- COP nezobrazuje stale track jako aktuální bez vizuálního příznaku.
- UI ukazuje atribuci/licenci zdroje.
