# COP Weather And Radar Presentation Instructions

## Purpose

This document tells COP how to consume the current SIM weather and radar
provider output after the June 2026 radar-frame update. SIM remains a
server-to-server provider. COP remains the public map catalog, presentation and
decision layer.

## Current Weather Layer

`public.weather.current` is a point summary for the center of the requested bbox.
It is not an area overlay and it is not expected to paint the whole map extent.
The COP-facing contract remains `sourceId=open_meteo`; SIM may internally use
MET Norway Locationforecast as a corroborating/fallback model and expose that
only under `properties.providerProperties.weatherCorroboration`.

COP should render the feature when any of these identifiers is present:

- `properties.layerId = "public.weather.current"`
- `properties.providerLayerId = "weather.open_meteo"`
- `properties.sourceId = "open_meteo"`
- `properties.tags.mapDisplayHint = "weather_observation_point"`

For area-like weather visualization COP should prefer the grid and field layers:

- `public.weather.temperature_grid`
- `public.weather.wind_field`
- `public.weather.precipitation_grid`
- `public.weather.humidity_grid`
- `public.weather.pressure_grid`

The current point feature carries normalized metrics such as `temperatureC`,
`relativeHumidityPercent`, `precipitationMm`, `cloudCoverPercent`,
`windSpeedMps`, `windDirectionDeg`, `windGustMps` and `weatherCode`.

## Public Webcam Preview Layer

SIM publishes public origin webcams as the catalog layer
`public.weather.webcams` backed by provider layer `weather.chmi_webcams` and
feature layer `weather_webcams`.

The source id remains `chmi_weather_webcams` for compatibility with existing
COP layer wiring. The payload is now multi-origin: ČHMÚ, LAVDIS/SPS and
configured city/traffic camera feeds can appear in the same layer. SIM must
use direct origin feeds only; aggregator pages are not runtime data sources.

Each webcam feature must be treated as its own layer, not as a weather-station
observation:

- `properties.layer = "weather_webcams"`
- `properties.layerId = "public.weather.webcams"`
- `properties.providerLayerId = "weather.chmi_webcams"`
- `properties.sourceId = "chmi_weather_webcams"`

COP should render webcam features as selectable point icons. The feature stream
does not contain image payloads. On click, COP should open its own camera
preview window and use one of these SIM-provided URLs:

- `properties.providerProperties.camera.detailUrl`
- `properties.providerProperties.camera.snapshotUrl`

The detail endpoint returns contract `sim-weather-cameras-v1`:

```http
GET /situation-data/api/v1/weather-cameras/{locationId}
```

If COP calls SIM through its internal provider base URL, use:

```http
GET /api/v1/weather-cameras/{locationId}
```

The detail response contains a `cameras[]` array. Each item has:

- `cameraId`
- `name`
- optional `providerUrl`
- `snapshotUrl`
- `contentType`
- `snapshotAvailable`

For the actual image, render `snapshotUrl` as an image source when
`snapshotAvailable !== false`. SIM decodes ČHMÚ base64 images or fetches direct
origin snapshots server-side and responds with `image/gif`, `image/png` or
`image/jpeg` when available:

```http
GET /api/v1/weather-cameras/{locationId}/snapshot?cameraId={cameraId}
```

If a location has multiple cameras, COP should show them as tabs or a compact
selector inside the same preview window. If `cameraId` is omitted, SIM returns
the first camera for that location.

COP must keep the supplied origin attribution visible in the preview window.
Use `properties.providerProperties.camera.attribution` or the detail response
location `attribution`. Treat webcam imagery as visual situation context only.
Do not convert camera availability or image content into a user facing warning,
incident or automatic alert.

## Radar Overlay Rendering

Radar features from `chmi_weather_radar` are metadata carriers for a raster
overlay. Their polygon geometry is the raster extent and must not be rendered as
a filled vector polygon.

COP should read:

- `properties.rendering.mode = "raster_overlay"`
- `properties.rendering.doNotRenderGeometryFill = true`
- `properties.providerProperties.raster.url`
- `properties.providerProperties.raster.rawUrl`
- `properties.providerProperties.raster.boundsWgs84`
- `properties.providerProperties.raster.dataBoundsWgs84`
- `properties.providerProperties.raster.opacity`

Current ČHMÚ PNG products are raw framed rasters. They can contain source frame
lines, grid lines and embedded product text such as `CZRAD - ... MERGE`.
This is source-data content, not a COP rendering defect.

SIM now serves PNG radar frames through a clean server-side crop endpoint. The
clean endpoint detects the actual CHMI radar data frame, crops away the title
band, and turns neutral gray/black frame pixels into transparent pixels. For
non-forecast PNG products, `providerProperties.raster.url` points to:

```http
/api/v1/weather-radar/clean/{productId}/{fileName}
```

Use this URL as the map overlay source. Keep `rawUrl` only for diagnostics. COP
should not crop the raw image client-side.

Clean-frame indicators:

- `properties.providerProperties.raster.cleanRasterAvailable = true`
- `properties.providerProperties.raster.cleanMethod = "server_crop_to_data_bounds"`
- `properties.providerProperties.raster.servedImageMayContainFrame = false`
- `properties.providerProperties.raster.servedImageMayContainEmbeddedLabels = false`

Forecast archives can still be raw archive sequences and should be handled
separately.

## Radar Timeline And Replay Preparation

SIM now provides a radar frame catalog:

```http
GET /situation-data/api/v1/weather-radar/frames?product=merge1h&hours=6&limit=24
```

If COP calls SIM through its internal base URL, use the provider base plus:

```http
GET /api/v1/weather-radar/frames?product=merge1h&hours=6&limit=24
```

The response contract is `sim-weather-radar-frames-v1` and contains products
with frame arrays:

- `productId`
- `catalogLayerId`
- `observedAt`
- `validUntil`
- `sourceUrl`
- `cleanUrl`
- `stored`
- `cleanStored`
- optional `localUrl`
- `boundsWgs84`
- `dataBoundsWgs84`

For COP animation, use `cleanUrl` for PNG products and sort frames by
`observedAt` ascending for playback. Use `sourceUrl` only as the raw upstream
reference. Later, when SIM enables long-term storage, `cleanStored=true`
indicates that the clean frame is already present in SIM local cache.

## Suggested COP Behavior

In the layer tree:

- Show `public.weather.current` as a point weather observation.
- Show `public.weather.forecast_area` as forecast polygons from
  `layers=weather_forecast_area&source=weather_forecast`. Use
  `properties.providerProperties.presentation.symbolKey` for the icon and
  `riskScore`/`riskLevel` for fill or outline color. Do not infer all missing
  weather states as partly cloudy.
- On forecast-area click, open
  `properties.providerProperties.weatherForecast.detailUrl` and render the
  returned `charts[]` as the meteogram for temperature, precipitation, wind and
  weather risk.
- Show CHMI station weather/grid layers as measured/grid weather context.
- Show `public.weather.webcams` as point camera locations; open a custom preview
  window on click and load the snapshot through SIM.
- Show radar layers as raster overlays, not polygons.
- Label radar source as `ČHMÚ radar clean frame (SIM processed)`.

For timeline UI:

- Query `/weather-radar/frames` when a radar layer is selected.
- Cache the response briefly on the COP server side.
- Let the user select product and time frame.
- Animate by swapping the raster overlay URL to each frame `cleanUrl`.
- Use `observedAt` for labels and `validUntil` for freshness.
- Treat `warnings[]` in the catalog response as provider quality metadata, not
  as user-facing emergency alerts.

## Not Implemented In This Step

- No Effect-TS dependency was added.
- SIM does not yet store a long historical radar archive by default.
- SIM clean radar is currently a cropped PNG overlay, not XYZ/MVT tiles.
- SIM does not publish raw lightning-strike positions.
