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
    "sources": ["mock", "open_meteo"]
  },
  "summary": {
    "featureCount": 8,
    "sourceCount": 2,
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
| `layer` | `weather`, `ground`, `mobile`, `traffic` | mapová vrstva |
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

## Chování při chybách

- Nevalidní `bbox` nebo `layers` vrací `400 VALIDATION_ERROR`.
- Výpadek jednoho zdroje se promítne do `warnings`; agregát má vrátit dostupné features z ostatních zdrojů.
- Pokud selžou všechny zdroje, endpoint stále může vrátit prázdnou kolekci s warnings.

## COP doporučení

- Dotazovat podle bbox aktuální mapy, ne plošně celou ČR.
- Default `limit=250`.
- Weather a mobile vrstvy zobrazovat jako kontext, ne jako track historii.
- U každého objektu zobrazovat zdroj a licenci.
