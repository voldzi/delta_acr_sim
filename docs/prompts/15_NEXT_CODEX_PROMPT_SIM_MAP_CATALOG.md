# Prompt pro SIM: Map Catalog v1 provider metadata

## Kontext

COP zavádí autoritativní, zdrojově neutrální mapový katalog `Map Catalog v1`. SIM je důležitý provider, ale není jediný možný zdroj mapových informací. COP bude do budoucna skládat vrstvy také z TAK Gateway, komunitních hlášení, uživatelských zón, interních registrů, tile služeb a dalších partnerů.

Autoritativní dokument v COP:

```text
/Users/voldzi/Documents/Development/18 2026/DELTA_ACR/01 COP/docs/integration/08_MAP_CATALOG_V1.md
```

SIM má dodat metadata tak, aby COP nemusel hardcodovat stovky vrstev a aby nemíchal uživatelské vrstvy s technickými zdroji.

## Hlavní princip

`enabled=true` ve `/sources` znamená pouze, že SIM zdroj běží. Neznamená to, že COP ho má automaticky zobrazit jako běžnou mapovou vrstvu.

SIM musí rozlišit:

- `layer`: datový produkt vhodný pro mapu,
- `source`: technický upstream/adaptér,
- `sourceRole`: role zdroje (`final`, `aggregate`, `reference`, `input`, `projection`, `mock`, `diagnostic`),
- `audience`: komu je vrstva/zdroj určena (`public`, `authenticated`, `partner`, `admin`, `diagnostic`),
- `technicalInputs`: vstupy použité modelem, které nejsou samostatné běžné vrstvy,
- `supersedes` / `replacedBy`: vztah starších nebo technických vrstev k finální vrstvě.

## Co má SIM implementovat

Přidej nový metadata endpoint:

```http
GET /situation-data/api/v1/catalog
```

Volitelně později i obdobné endpointy:

```http
GET /safety-data/api/v1/catalog
GET /flight-data/api/v1/catalog
GET /tak-gateway/api/v1/catalog
```

Endpoint nesmí rušit existující `/layers`, `/sources` ani `/cop/features`. Je to doplňkový katalog pro COP.

## Minimální odpověď

```json
{
  "catalogVersion": "provider-map-catalog-v1",
  "providerId": "sim.situation-data",
  "generatedAt": "2026-05-22T08:00:00.000Z",
  "layers": [],
  "sources": []
}
```

## Provider layer metadata

Každá položka `layers[]` musí obsahovat:

```json
{
  "providerLayerId": "mobile_network",
  "recommendedCatalogLayerId": "public.mobile.network",
  "label": "Mobilní síť",
  "description": "Sjednocené občanské hodnocení dostupnosti mobilní sítě.",
  "categoryPath": ["communications", "mobile"],
  "role": "overlay",
  "audience": "public",
  "kind": "vector_features",
  "defaultVisible": false,
  "selectable": true,
  "geometryTypes": ["Polygon"],
  "minZoom": 6,
  "maxZoom": 18,
  "refreshSeconds": 300,
  "cacheTtlSeconds": 600,
  "styleProfile": "mobile-network-quality-v1",
  "sourceIds": ["mobile_network_model"],
  "technicalInputs": [
    "mobile_coverage_model",
    "ctu_nettest",
    "osm_postgis"
  ],
  "filters": [
    {
      "filterId": "technology",
      "type": "multi_select",
      "values": ["2G", "4G", "5G"],
      "defaultValue": ["4G"]
    }
  ],
  "legal": {
    "attribution": "Czech Telecommunication Office / CTU-NetTest; OpenStreetMap contributors where tower hints are used",
    "notes": [
      "Modelový odhad, ne garantované pokrytí ani potvrzený výpadek operátora."
    ]
  }
}
```

## Provider source metadata

Každá položka `sources[]` má rozšířit stávající source registry minimálně o:

```json
{
  "sourceId": "mobile_coverage_model",
  "label": "Mobile coverage estimate model",
  "enabled": true,
  "sourceRole": "input",
  "audience": "diagnostic",
  "selectableInMap": false,
  "visibleInDiagnostics": true,
  "feedsCatalogLayerIds": ["diagnostic.mobile.coverage"],
  "usedByCatalogLayerIds": ["public.mobile.network"],
  "replacedBy": "mobile_network_model",
  "updateCadenceSeconds": 21600,
  "cacheTtlSeconds": 21600
}
```

## Povinná klasifikace současných situation-data položek

Nastav doporučenou interpretaci takto:

| SIM item | Doporučený catalog layer | role/sourceRole | audience | selectableInMap |
| --- | --- | --- | --- | --- |
| `weather` + `open_meteo` | `public.weather.current` | `primary` / `final` | `public` | true |
| `weather` + `aviation_weather` | `public.weather.aviation` | `reference` / `final` | `public` | true |
| `mobile_network` + `mobile_network_model` | `public.mobile.network` | `overlay` / `aggregate` | `public` | true |
| `mobile_coverage` + `mobile_coverage_model` | `diagnostic.mobile.coverage` | `diagnostic` / `input` | `diagnostic` | false |
| `mobile` + `ctu_nettest` | `diagnostic.mobile.ctu_measurements` | `diagnostic` / `input` | `diagnostic` | false |
| `mobile` + `osm_postgis` communications towers | `reference.infrastructure.communications` | `reference` / `reference` | `public` or `diagnostic` | false by default |
| `ground` + `osm_postgis` hospitals/fire/police/pharmacy/shelter/townhall | `reference.infrastructure.*` | `reference` / `reference` | `public` | true |
| `traffic` + `pid_gtfs_rt` | `public.traffic.transit` | `reference` / `final` | `public` | true |
| `warnings/flood` via `safety_data` projection | compatibility only | `projection` | `public` | false by default |
| `mock` | none or diagnostic | `mock` | `diagnostic` | false |

Safety-data má být preferovaný provider pro `warnings` a `flood`; situation-data projection je pouze kompatibilita.

## DEM a model metadata

SIM health už může hlásit dostupné DEM, ale konkrétní modelová vrstva musí jasně uvádět, jestli DEM používá.

Do katalogu doplň:

```json
{
  "model": {
    "modelVersion": "mobile-network-v1",
    "terrainAware": false,
    "demSource": "not-used-phase-1",
    "confidenceExplanation": "Combines public measurements, inferred coverage and OSM infrastructure hints."
  }
}
```

Pokud se později zapne terrain-aware výpočet, změň `terrainAware=true`, `demSource=<datasetId>` a případně `styleProfile` nebo `modelVersion`.

## Přístupová politika

SIM musí u katalogu jasně rozlišovat:

- veřejná metadata,
- partner-only metadata,
- diagnostická metadata,
- mock/test metadata.

Neveřejné zdroje jako ARDOS/TAK nesmí být označené jako veřejně selectable jen proto, že služba běží.

## Akceptační kritéria

1. `GET /situation-data/api/v1/catalog` vrací `catalogVersion=provider-map-catalog-v1`.
2. Každá vrstva má `recommendedCatalogLayerId`, `role`, `audience`, `kind`, `styleProfile`, `sourceIds`, `refreshSeconds`, `cacheTtlSeconds`.
3. Každý zdroj má `sourceRole`, `audience`, `selectableInMap`, `visibleInDiagnostics`.
4. `mobile_network_model` je finální/agregovaná veřejná mobilní vrstva.
5. `mobile_coverage_model`, `ctu_nettest` a OSM věže nejsou běžné mobilní vrstvy, ale technické vstupy nebo reference.
6. `safety_data` projection je označená jako `projection`, ne jako primární safety provider.
7. Existující `/layers`, `/sources` a `/cop/features` zůstávají kompatibilní.
8. Dokumentace SIM odkazuje na COP `Map Catalog v1` jako autoritativní source-neutral kontrakt.

## Poznámka k civilnímu použití

Texty v licencích, attributions a popisech nemají používat názvy původní vojenské inspirace. Ve veřejném civilním UI se má používat neutrální jazyk: civilní situační mapa, veřejné zdroje, modelový odhad, partner feed, komunitní hlášení.

