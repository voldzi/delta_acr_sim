# Pokyn pro COP: zobrazení SIM vrstvy mobile_coverage

SIM nově poskytuje odhad mobilního pokrytí jako připravenou mapovou vrstvu. COP ji má pouze zobrazovat a filtrovat; COP nemá počítat coverage, stahovat DEM/terrain data ani dotazovat OSM.

## Endpointy

Base URL:

```text
https://sim.zeleznalady.cz/situation-data/api/v1
```

Registry:

```http
GET /layers
GET /sources
GET /mobile-coverage/metadata
```

Features:

```http
GET /cop/features?bbox=west,south,east,north&layers=mobile_coverage&source=mobile_coverage_model&technology=4G&limit=250
```

Parametry:

- `bbox`: aktuální mapový výřez, WGS84 `west,south,east,north`,
- `technology` nebo `technologies`: `2G`, `4G`, `5G`, comma-separated,
- `operator` nebo `operators`: zatím pouze `unknown`,
- `limit`: defaultně používej 250, při malém výřezu lze zvýšit podle výkonu mapy.

## Kontrakt feature

Feature je GeoJSON `Polygon` ve vrstvě `mobile_coverage`:

```json
{
  "type": "Feature",
  "geometry": { "type": "Polygon", "coordinates": [] },
  "properties": {
    "featureId": "coverage:mobile:4g:0-0",
    "layer": "mobile_coverage",
    "category": "mobile_coverage",
    "label": "4G coverage estimate",
    "sourceId": "mobile_coverage_model",
    "operator": "unknown",
    "technology": "4G",
    "quality": "fair",
    "estimatedSignalDbm": -98,
    "confidence": 0.62,
    "modelVersion": "coverage-v1",
    "generatedAt": "2026-05-21T00:00:00.000Z",
    "resolutionM": 1000,
    "demSource": "not-used-phase-1",
    "assumptions": {
      "antennaHeightM": 30,
      "propagationModel": "distance-path-loss-lite",
      "terrainAware": false,
      "landCoverAware": false
    },
    "stale": false,
    "disclaimer": "Coverage is an estimate, not guaranteed service availability."
  }
}
```

## UI požadavky

- Přidat samostatnou vrstvu `Mobilní pokrytí` / `Mobile coverage estimate`.
- Defaultně vypnout, protože jde o plošný overlay.
- Přidat filtr technologie `2G / 4G / 5G`.
- Operátor je zatím `unknown`, filtr operátora může zůstat skrytý.
- Zobrazit legendu kvality:
  - `good`: zelená,
  - `fair`: žlutá,
  - `weak`: oranžová,
  - `none`: červená nebo tmavě šedá,
  - `unknown`: šedá.
- V detailu polygonu zobrazit `quality`, `technology`, `estimatedSignalDbm`, `confidence`, `modelVersion`, `generatedAt`, `resolutionM`, `demSource` a disclaimer.
- Pro uživatele v oblasti `weak` nebo `none` připravit nenásilné upozornění typu "oblast slabého/žádného odhadovaného pokrytí".

## Cache a dependency stav

SIM cacheuje coverage výstupy server-side. COP má:

- dotazovat podle aktuálního bbox, ne celou ČR,
- nepollovat rychleji než jednou za 5-15 minut,
- sdílet odpověď v aplikačním store mezi komponentami,
- degraded stav vyhodnocovat z `warnings[]`, `summary.staleFeatureCount`, `sourceHealth` a prázdné odpovědi při očekávané vrstvě,
- nikdy nezobrazovat výstup jako garantované pokrytí operátora.

## Akceptační testy COP

```text
https://sim.zeleznalady.cz/situation-data/api/v1/mobile-coverage/metadata
https://sim.zeleznalady.cz/situation-data/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_coverage&source=mobile_coverage_model&technology=4G&limit=20
```

Očekávání:

- metadata obsahují `qualityLevels`, `cacheTtlSeconds`, `disclaimer` a `assumptions`,
- features jsou polygonové,
- každá feature má `quality`, `technology`, `confidence`, `modelVersion`, `resolutionM`,
- při warning/degraded stavu nespadne celá mapa.
