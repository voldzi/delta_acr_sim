# Pokyn pro COP: zobrazení sjednocené SIM vrstvy mobile_network

SIM nově poskytuje jednu preferovanou mobilní vrstvu `mobile_network`. COP ji má používat jako hlavní informaci pro občana. COP nemá skládat vlastní závěr z `mobile_coverage`, ČTÚ NetTest bodů nebo OSM věží.

## Base URL

```text
https://sim.zeleznalady.cz/situation-data/api/v1
```

## Endpointy

Registry:

```http
GET /layers
GET /sources
GET /config
GET /catalog
```

COP má pro layer tree a defaultní mapové checkboxy preferovat `GET /catalog`. `/sources.enabled=true` znamená pouze provozní stav zdroje v SIM, ne doporučení k běžnému vykreslení.

Features:

```http
GET /cop/features?bbox=west,south,east,north&layers=mobile_network&source=mobile_network_model&limit=250
```

Volitelné filtry:

- `technology` nebo `technologies`: `2G`, `4G`, `5G`, comma-separated,
- `operator` nebo `operators`: zatím `aggregate` a `unknown`,
- `limit`: běžně 250.

## Feature kontrakt

Feature je GeoJSON `Polygon` ve vrstvě `mobile_network`:

```json
{
  "type": "Feature",
  "geometry": { "type": "Polygon", "coordinates": [] },
  "properties": {
    "featureId": "network:mobile:4g:coverage-cell-id",
    "layer": "mobile_network",
    "category": "mobile_network",
    "label": "4G mobile network assessment",
    "sourceId": "mobile_network_model",
    "operator": "aggregate",
    "technology": "4G",
    "quality": "fair",
    "status": "ok",
    "basis": [
      "CTU_NETTEST_MEASUREMENT",
      "INFERRED_COVERAGE",
      "OSM_INFRASTRUCTURE_HINT",
      "NO_OPERATOR_BTS_STATUS"
    ],
    "summary": "Mobilni sit: pouzitelne s omezenim. Zaver kombinuje odhad pokryti a verejna mereni.",
    "notices": [
      "Aktualni stav konkretni BTS neni verejne overen; nejde o potvrzeny vypadek operatora."
    ],
    "estimatedSignalDbm": -98,
    "confidence": 0.62,
    "modelVersion": "mobile-network-v1",
    "generatedAt": "2026-05-21T00:00:00.000Z",
    "resolutionM": 1000,
    "demSource": "not-used-phase-1",
    "stale": false,
    "disclaimer": "Mobile network assessment is inferred from public/modelled data; it is not a confirmed BTS outage or guaranteed service availability."
  }
}
```

## UI chování

- Zobrazit jako jednu vrstvu `Mobilní síť`.
- Defaultně vypnout, protože jde o plošný overlay.
- Barvu mapy řídit podle `quality`:
  - `good`: zelená,
  - `fair`: žlutá,
  - `weak`: oranžová,
  - `none`: červená nebo tmavě šedá,
  - `unknown`: šedá.
- Výstrahy řídit podle `status`:
  - `weak_signal`: oblast se slabým signálem,
  - `degraded_possible`: možná degradace,
  - `outage_reported`: potvrzený výpadek až po autorizovaném partnerském feedu,
  - `unknown`: nezobrazovat jako problém, jen jako nedostatek dat.
- Detail polygonu zobrazí `summary`, `quality`, `status`, `technology`, `confidence`, `estimatedSignalDbm`, `basis`, `notices`, `modelVersion`, `generatedAt`, `resolutionM`, `demSource` a `disclaimer`.
- `basis` použít jako vysvětlení kvality dat, ne jako samostatné vrstvy.
- `mobile_coverage` zobrazovat jen v technickém/debug režimu, ne jako hlavní občanskou informaci.

## Cache a provoz

SIM cacheuje `mobile_network` server-side. COP má:

- dotazovat podle aktuálního bbox,
- sdílet odpověď mezi komponentami v server-side/app cache,
- nepollovat plošnou vrstvu rychleji než jednou za několik minut,
- degraded stav vyhodnocovat z `warnings[]`, `summary.staleFeatureCount` a health/dependency endpointů,
- nikdy nezobrazovat výstup jako garantované pokrytí operátora nebo potvrzený stav konkrétní BTS.

## Akceptační testy COP

```text
https://sim.zeleznalady.cz/situation-data/api/v1/layers
https://sim.zeleznalady.cz/situation-data/api/v1/sources
https://sim.zeleznalady.cz/situation-data/api/v1/catalog
https://sim.zeleznalady.cz/situation-data/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_network&source=mobile_network_model&limit=20
```

Očekávání:

- `/layers` obsahuje `mobile_network`,
- `/sources` obsahuje `mobile_network_model`,
- `/catalog` obsahuje `public.mobile.network` jako veřejnou selectable vrstvu a označí `mobile_coverage_model`, `ctu_nettest` a OSM věže jako technické/diagnostické vstupy,
- features jsou polygonové,
- každá feature má `quality`, `status`, `confidence`, `basis`, `summary`, `disclaimer`,
- při warning/degraded stavu nespadne celá mapa.
