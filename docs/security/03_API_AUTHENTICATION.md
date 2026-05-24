# API authentication

**Status:** Baseline dokumentace

## SIM API

SIM API musí v implementaci vyžadovat autentizaci pro všechny neveřejné endpointy. Health liveness může být veřejný v lokálním režimu, readiness/dependencies mohou být omezené podle prostředí.

SIM podporuje statické bearer tokeny i Keycloak/OIDC JWT. Doporučený produkční režim je `SIM_API_AUTH_MODE=hybrid`, kde Keycloak tokeny z realmu COP s rolemi `csm-sim-viewer`, `csm-sim-operator` a `csm-sim-admin` řídí běžné UI použití a statický `SIM_API_ADMIN_TOKEN` slouží pouze jako nouzový fallback. Pro sdílené účty v realmu COP SIM zároveň akceptuje `cop_user` jako viewer, `cop_operator` jako operator a `cop_admin` jako admin. Režim `oidc` vypíná statické tokeny.

`SIM_API_PUBLIC_READ=true` smí povolit pouze read-only dashboard endpointy potřebné pro veřejný náhled SIM UI, například seznam scénářů, runtime status, runtime bloky a stav publisheru. Mutace scénářů, start/stop runtime, publisher queue, metriky a změny konfigurace musí zůstat chráněné bearer tokenem.

## COP API

Publisher používá bearer token jako baseline a návrhově podporuje mTLS/OIDC client credentials. `X-Source-System-Id`, `X-Contract-Version`, `X-Idempotency-Key` a `X-Correlation-Id` jsou povinné integrační hlavičky.

## Audit

Auth selhání a změny auth konfigurace se auditují bez ukládání tajných hodnot.
