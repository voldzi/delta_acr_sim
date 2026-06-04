# Map Catalog Provider Contract

## Účel

Provider catalog říká COM, jaké mapové produkty provider nabízí a jak je má COM server-side dotazovat. Katalog neslouží k přímému volání z prohlížeče.

SIM publikuje aktuální provider katalog zde:

```http
GET /situation-data/api/v1/catalog
GET /safety-data/api/v1/catalog
GET /flight-data/api/v1/catalog
GET /tak-gateway/api/v1/catalog
```

## Minimální struktura

```json
{
  "contractVersion": "provider-map-catalog-v1",
  "catalogVersion": "provider-map-catalog-v1",
  "providerId": "sim.situation-data",
  "generatedAt": "2026-05-22T08:00:00.000Z",
  "status": "online",
  "authority": {
    "contractVersion": "map-catalog-v1",
    "catalogVersion": "map-catalog-v1",
    "document": "docs/provider/02_MAP_CATALOG_PROVIDER_CONTRACT.md"
  },
  "layers": [],
  "sources": []
}
```

## Vrstva

Vrstva je produkt pro uživatele. COM ji může zobrazit v katalogu, uložit do profilu uživatele a použít pro mapový dotaz.

Povinné nebo prakticky povinné položky:

- `providerLayerId`: lokální ID vrstvy u providera.
- `recommendedCatalogLayerId`: doporučené source-neutral COM ID, například `public.mobile.network`.
- `label`, `description`; pro veřejné civilní vrstvy také `labelLocalized` a `descriptionLocalized`, typicky `cs` a `en`.
- `categoryPath`.
- `categories`.
- `role`: `primary`, `reference`, `overlay`, `user`, `partner`, `diagnostic`.
- `audience`: `public`, `authenticated`, `partner`, `diagnostic`.
- `kind`: `vector_features`, `grid_field`, `vector_field`, `mvt_tiles`, `raster_tiles`, `track_stream`, `static_reference`.
- `defaultVisible`, `selectable`.
- `geometryTypes`.
- `refreshSeconds`, `cacheTtlSeconds`.
- `styleProfile`.
- `sourceIds`.
- `query`.
- `legal`.
- `delivery`, pokud jde o grid, tile nebo vector-field vrstvu; např. stabilní WGS84 grid alignment.
- `readModel`, pokud provider servíruje data z materializované cache/tabulky.
- `notificationPolicy`, pokud vrstva obsahuje civilní události vhodné pro
  uživatelské notifikace. Toto pole je instrukce pro COP backend; provider
  samotný notifikace neposílá.

Příklad `notificationPolicy`:

```json
{
  "eligible": true,
  "audienceDecisionOwner": "cop",
  "deliveryOwner": "csm-messaging",
  "deduplicationKeyFields": [
    "providerId",
    "providerLayerId",
    "featureId",
    "validFrom",
    "validUntil"
  ],
  "recommendedNotificationTypes": ["safety.alert"],
  "minimumSeverityForUserPush": "advisory",
  "technicalWarningsPolicy": "never_push_to_public_users"
}
```

## Source

Source je technický zdroj, upstream nebo model. Source s `enabled=true` se automaticky nemá zobrazit jako uživatelská vrstva.

Provider má u každého source uvádět:

- `sourceId`
- `label`
- `enabled`
- `sourceRole`
- `audience`
- `selectableInMap`
- `visibleInDiagnostics`
- `feedsLayerIds`
- `feedsCatalogLayerIds`
- `usedByLayerIds`
- `usedByCatalogLayerIds`
- `technicalInputs`, pokud source vzniká agregací nebo modelem
- `cacheTtlSeconds`
- `license`
- `notes`

## Query objekt

`query` je instrukce pro COM backend. `streamId` je neprůhledný identifikátor streamu, nikoli veřejná URL.

```json
{
  "mode": "bbox",
  "providerId": "sim.situation-data",
  "streamId": "cop.features",
  "providerLayerIds": ["mobile_network"],
  "providerSourceIds": ["mobile_network_model"],
  "maxFeatures": 250
}
```

Aktuální SIM používá kompatibilní `streamId=cop.features`, protože stávající COM backend ho mapuje na server-side provider stream. Noví provideři mají používat stabilní `providerId`, `providerLayerIds` a `providerSourceIds`; konkrétní `streamId` se domlouvá s COM adapterem a nesmí být volán z klientského prohlížeče.

## Feature properties

Každá feature vrácená provider streamem má nést normalizované identifikátory, aby COM nemusel odvozovat význam z interního `sourceId`:

```json
{
  "properties": {
    "layerId": "public.mobile.network",
    "providerId": "sim.situation-data",
    "providerLayerId": "mobile_network",
    "sourceId": "mobile_network_model",
    "category": "mobile_network",
    "label": "4G",
    "observedAt": "2026-05-22T08:00:00.000Z",
    "stale": false,
    "confidence": 0.72,
    "severity": "info",
    "providerProperties": {}
  }
}
```

`layerId` je doporučené COM katalogové ID. `providerLayerId` je lokální provider vrstva. `providerProperties` obsahují provider-native hodnoty jako `quality`, `technology`, `basis`, `metrics`, `tags`, modelové verze a disclaimery.

## Hlavní mobilní vrstva

Pro občanské zobrazení mobilní sítě je jediná doporučená vrstva:

- COM layer: `public.mobile.network`
- provider layer: `mobile_network`
- source: `mobile_network_model`
- role: `overlay`
- audience: `public`
- style: `mobile-network-quality-v1`

Diagnostické vstupy `mobile_coverage_model`, `ctu_nettest`, `ctu_stationary_mobile` a OSM komunikační infrastruktura nejsou samostatné běžné uživatelské vrstvy.

V `source` metadatech je `mobile_network_model` označen jako `sourceRole=final`, zatímco `mobile_coverage_model`, `ctu_nettest` a `ctu_stationary_mobile` jsou `sourceRole=input` a `audience=diagnostic`.

## Doporučená katalogová ID

SIM používá nebo doporučuje tato stabilní COM layer ID:

- `public.safety.weather_alerts`
- `public.safety.fire`
- `public.safety.flood`
- `public.boundary.admin`
- `public.boundary.country`
- `public.boundary.region`
- `public.boundary.district`
- `public.boundary.orp`
- `public.place.settlements`
- `public.weather.current`
- `public.weather.aviation`
- `public.weather.observations`
- `public.weather.temperature_grid`
- `public.weather.wind_field`
- `public.weather.precipitation_grid`
- `public.weather.humidity_grid`
- `public.weather.pressure_grid`
- `public.weather.radar_reflectivity`
- `public.weather.radar_precipitation`
- `public.weather.radar_nowcast`
- `public.safety.thunderstorm_risk`
- `public.safety.air_quality`
- `public.safety.air_quality_grid`
- `public.mobile.network`
- `public.traffic.transit`
- `public.traffic.road_events`
- `reference.infrastructure.healthcare`
- `reference.infrastructure.emergency`
- `reference.infrastructure.communications`
- `flight.public.tracks`
- `flight.reference.airports`
- `flight.reference.airspaces`
- `flight.reference.uas_geozones`
- `flight.airspace.activation`
- `partner.tak.mobile`
- `partner.tak.ground`
- `partner.tak.traffic`
- `diagnostic.mobile.coverage`
- `diagnostic.mobile.ctu_measurements`

## Kompatibilní feature streamy v SIM

Tyto cesty existují pro backend COM a pro přímé integrační testy:

```http
GET /situation-data/api/v1/features
GET /safety-data/api/v1/features
GET /tak-gateway/api/v1/features
GET /flight-data/api/v1/aircraft/positions
```

Historické aliasy `/api/v1/cop/features` a `/api/v1/cop/tracks` jsou zachované kvůli současným adaptérům, ale nejsou doporučený veřejný kontrakt pro nové klienty.
