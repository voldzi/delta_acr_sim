# ADR-0014: Normalized Public Transit Context

## Status
Accepted

## Context

COP needs a public-transport view similar to city transit maps: live vehicle
positions, line number, direction, next stop, stop list, scheduled and realtime
times, route geometry and service alerts. SIM already exposes basic public
transport vehicle positions from PID/Golemio GTFS-RT and an optional IDS JMK
vehicle-position feed, but that is not enough for a PID-map-like user
experience.

Different Czech cities and regions expose different combinations of GTFS static,
GTFS-RT, JSON APIs and service alerts. If COP integrates each source directly,
the presentation layer would inherit upstream-specific parsing, licensing,
staleness and data-quality behavior. That conflicts with the provider model
where SIM is the server-side data provider and COP renders normalized map
layers.

## Decision

SIM will own a normalized public-transit context model under
`public.traffic.transit` and `public.traffic.transit_stops`.

The map stream stays lightweight and returns vehicle point features and static
stop point features through the existing `situation-data` `traffic` layer. SIM
will enrich those features with stable transit properties and provider metadata.
Heavier details such as route shape, stop list, scheduled/realtime stop times
and service alerts will be served by dedicated transit detail endpoints rather
than by every bbox map poll.

Each city or regional system is integrated as an adapter into the same internal
model:

- static model: routes, stops, trips, stop times, calendars and shapes,
- realtime model: vehicle positions, trip updates and service alerts,
- normalized COP fields: mode, line, destination, delay, vehicle, trip,
  next/previous stop, status and quality.

COP will not call city upstream APIs directly and will not parse raw
provider-native payload as user-facing meaning.

## Consequences

SIM can add more Czech cities without changing the COP layer tree. COP renders
one `public.traffic.transit` layer and uses source/system metadata only for
labels, attribution and filtering.

The model requires persistent or long-lived static GTFS caching, source-specific
licence tracking and additional tests per adapter. The generic static read-model
now caches configured public GTFS/GeoJSON feeds for stop, route, trip, stop-time,
calendar and shape detail endpoints. A full PID-map-like live detail still
requires both vehicle positions and trip updates; sources without trip updates
will show static schedules or a lower-confidence detail with clear quality
warnings.

The map stream remains scalable because route shapes and stop-time tables are
loaded only on click or through a detail endpoint.

## Alternatives Considered

- Let COP integrate Golemio/PID and each city API directly. Rejected because it
  duplicates parsing and creates inconsistent behavior across cities.
- Add one catalog layer per city. Rejected for the default UX because operators
  need a single traffic/transit layer; city/source filters can be metadata.
- Put complete stop lists and route shapes in every map feature. Rejected
  because it would make bbox polling heavy and would not scale to city-wide
  refresh intervals.

## Follow-up Actions

- PID static GTFS read-model and the PID transit detail endpoint are implemented
  in the first runtime increment.
- Generic `public_transit_static` stop, departure, route and trip detail
  endpoints are implemented over the long-lived static read-model.
- Add PID trip updates and service alerts when available.
- `providerProperties.transit` is implemented for PID and IDS JMK map features.
- Add IDS JMK realtime detail adapter using the same model.
- Add adapter registry for additional Czech cities and regional systems.
