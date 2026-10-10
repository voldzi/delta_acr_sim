# Contract testing

**Status:** Baseline dokumentace

## Rozsah

- OpenAPI endpoint existence
- JSON Schema validace scénáře
- canonical event envelope validace
- publisher config validace
- AI draft validace
- standard error model
- `sim-crisis-media-context-v1`: oddělený server-to-server news endpoint,
  query allowlist, default-disabled, metadata-only/no GPS/eventAt=null,
  notificationEligible=false a explicitní feed/stale/error stavy
- `sim-safety-notification-candidates-v1`: eligibility provenance/precision
  guard a additive inputReadiness; ne-ready vstup vrací prázdné kandidáty,
  zachovává diagnostiku a nepropaguje technické warningy do veřejného push
- `geo-routing-v1`: walking/bicycle, ordered 2+ waypoints, GeoJSON/elevation,
  dataset metadata, invalid input, no optimization, service auth/browser
  rejection, Valhalla degradation and publication idempotency

## Mock COP

Mock COP endpoint musí vracet úspěch, validaci, auth chyby, rate limit, server error a idempotency konflikt pro deterministické testy.

## Gates

Contract test selhání blokuje změnu publisheru i změnu event schema.
