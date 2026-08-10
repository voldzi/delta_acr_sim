# API authentication

**Status:** Baseline dokumentace

## SIM API

SIM API musí v implementaci vyžadovat autentizaci pro všechny neveřejné endpointy. Health liveness může být veřejný v lokálním režimu, readiness/dependencies mohou být omezené podle prostředí.

Produkčně platí, že SIM může být vystaven jako samostatné operační centrum jen
přes Keycloak/OIDC a SIM role. Provider endpointy nejsou veřejné browser API a
mají být dostupné pouze server-to-server z COP backendu, interních sítí nebo
VPN. Veřejně smí zůstat statické UI, `/api/v1/*` za bearer tokenem a
`GET /health/live`. Detaily Nginx allowlistu jsou v
[../runbooks/12_PROVIDER_ACCESS_CONTROL.md](../runbooks/12_PROVIDER_ACCESS_CONTROL.md).

SIM podporuje statické bearer tokeny i Keycloak/OIDC JWT. Doporučený produkční režim je `SIM_API_AUTH_MODE=hybrid`, kde Keycloak tokeny z realmu COP s rolemi `csm-sim-viewer`, `csm-sim-operator` a `csm-sim-admin` řídí běžné UI použití a statický `SIM_API_ADMIN_TOKEN` slouží pouze jako nouzový fallback. Pro sdílené účty v realmu COP SIM zároveň akceptuje `cop_user` jako viewer, `cop_operator` jako operator a `cop_admin` jako admin. Režim `oidc` vypíná statické tokeny.

Internetový profil musí mít `SIM_API_PUBLIC_READ=false`. `SIM_API_PUBLIC_READ=true`
je povoleno jen pro interní/lab režim a smí zpřístupnit pouze read-only dashboard
endpointy. Mutace scénářů, start/stop runtime, publisher queue, metriky a změny
konfigurace musí zůstat chráněné bearer tokenem vždy.

## COP API

Publisher používá bearer token jako baseline a návrhově podporuje mTLS/OIDC client credentials. `X-Source-System-Id`, `X-Contract-Version`, `X-Idempotency-Key` a `X-Correlation-Id` jsou povinné integrační hlavičky.

## Internal geo-routing-v1

`POST /situation-data/api/v1/geo-routing-v1/route` uses a separate opaque
service token for each consuming backend. Tokens are configured as
`actor:token` entries in `GEO_ROUTING_SERVICE_TOKENS`; the fixed audience is
`csm-sim-geo-routing-v1` and the operation scope is `geo-routing:route`.
Rate limiting and idempotency namespaces use the authenticated actor. A request
with a browser `Origin` header is rejected even when it carries a valid token.
The public client must call its own backend and must never call SIM or Valhalla.
Details are in
[19_GEO_ROUTING_V1_CONTRACT.md](../integration/19_GEO_ROUTING_V1_CONTRACT.md).

## Audit

Auth selhání a změny auth konfigurace se auditují bez ukládání tajných hodnot.
