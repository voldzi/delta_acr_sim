# Prompt pro navazující práci v projektu COP: situační open-data vrstvy ze SIM

Jsi Codex v sousedícím projektu COP (`/srv/cop`, publikováno jako `https://cop.zeleznalady.cz`). SIM běží jako samostatná aplikace na `https://sim.zeleznalady.cz` a nově bude poskytovat vedle syntetických tracků a flight-data také agregované situační vrstvy pro společný obraz situace.

## Cíl

Uprav COP tak, aby uměl načítat, zobrazovat a provozně hlídat externí situační zdroj ze SIM:

- veřejná URL služby: `https://sim.zeleznalady.cz/situation-data/api/v1`
- hlavní endpoint pro mapu: `GET /cop/features?bbox=west,south,east,north&layers=weather,ground,mobile,traffic&limit=250`
- kontrakt: `cop-situation-source-v1`
- formát: GeoJSON `FeatureCollection` s normalizovanými `properties`

COP musí tyto vrstvy zobrazovat jako doplňkový kontext, ne jako vlastní COP tracky letadel. Tracky z `/flight-data/api/v1/cop/tracks` zůstávají samostatný vzdušný zdroj.

## Očekávaný kontrakt

```http
GET https://sim.zeleznalady.cz/situation-data/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=weather,ground,mobile,traffic&limit=250
```

Odpověď:

```json
{
  "contractVersion": "cop-situation-source-v1",
  "type": "FeatureCollection",
  "generatedAt": "2026-05-20T10:15:00.000Z",
  "source": {
    "sourceId": "situation-data-api",
    "sourceType": "PUBLIC_SITUATION_AGGREGATE"
  },
  "query": {
    "bbox": { "west": 13.85, "south": 49.65, "east": 15.35, "north": 50.45 },
    "layers": ["weather", "ground", "mobile", "traffic"],
    "limit": 250
  },
  "summary": {
    "featureCount": 12,
    "sourceCount": 3,
    "staleFeatureCount": 0,
    "warningCount": 0
  },
  "features": [
    {
      "type": "Feature",
      "id": "weather:open_meteo:50.1008:14.2632",
      "geometry": { "type": "Point", "coordinates": [14.2632, 50.1008] },
      "properties": {
        "featureId": "weather:open_meteo:50.1008:14.2632",
        "layer": "weather",
        "category": "weather_observation",
        "label": "Weather near Prague",
        "sourceId": "open_meteo",
        "observedAt": "2026-05-20T10:00:00.000Z",
        "confidence": 0.86,
        "stale": false,
        "severity": "info",
        "license": {
          "name": "CC BY 4.0 / Open-Meteo Terms",
          "attribution": "Weather data by Open-Meteo.com"
        },
        "metrics": {
          "temperatureC": 18.3,
          "windSpeedMps": 4.1,
          "precipitationMm": 0
        }
      }
    }
  ],
  "sources": [],
  "warnings": []
}
```

## UI požadavky v COP

1. Přidej zdroj "SIM Situation Data" do seznamu datových zdrojů.
2. V mapě vykresli vrstvy samostatně:
   - `weather`: bodové počasí, vítr, srážky, případně výstražná barva podle `severity`
   - `ground`: pozemní referenční objekty a infrastruktura
   - `mobile`: dostupnost/kvalita mobilní sítě a měřicí body
   - `traffic`: dopravní incidenty, uzavírky, omezení nebo testovací dopravní kontext
3. Přidej toggly vrstev. Výchozí stav: `weather` zapnuto, ostatní volitelné podle výkonu mapy.
4. V detailu objektu zobraz `label`, `category`, `sourceId`, čas `observedAt`, `confidence`, `stale`, licenci a klíčové `metrics`.
5. Nevykresluj tyto features jako COP track historii. Jsou to kontextové objekty, většinou statické nebo pomalu proměnné.
6. Když endpoint vrátí `warnings`, zobraz nenápadný stav zdroje. Warnings nesmí shodit mapu.
7. Když endpoint není dostupný, COP musí běžet dál a jen označit zdroj jako degraded/offline.

## Integrace a výkon

- Dotazuj podle aktuálního bbox mapy. Pro první pilot použij debounce 2-5 s po změně mapy.
- Limituj výchozí `limit=250`, pro větší mapový výřez raději zobraz stav "zoom in for details".
- Cache v COP aspoň 10-30 s podle vrstvy.
- Respektuj `stale`; stará data zobraz šedě nebo se sníženou sytostí.
- Neposílej bearer token do SIM situačních endpointů, pilot je read-only.

## Akceptační kritéria

- COP načte `GET /situation-data/api/v1/layers` a zobrazí dostupné vrstvy.
- COP načte `GET /situation-data/api/v1/cop/features` pro bbox okolo Prahy a vykreslí alespoň weather feature.
- Přepnutí vrstev nemění letecké tracky ani jejich historii.
- Výpadek SIM situation-data endpointu nezpůsobí chybu celé mapy.
- Detail feature zobrazuje zdroj a licenci.
- Konzole prohlížeče je bez neobsloužených runtime chyb.

## Poznámka k licencím

Data ze SIM mohou kombinovat zdroje s různými licencemi:

- Open-Meteo Free API: nekomerční režim a CC BY 4.0 podmínky, komerční režim vyžaduje placený tarif.
- OpenStreetMap/Overpass: ODbL 1.0 a férové použití veřejných Overpass instancí.
- ČTÚ otevřená data: licence se liší podle datasetu, často CC BY 4.0; u každého zdroje používej metadata z `sources`.

COP má zobrazovat atribuci a nesmí v UI tvrdit, že jde o garantovaná operační data.
