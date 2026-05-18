# API authentication

**Status:** Baseline dokumentace

## SIM API

SIM API musí v implementaci vyžadovat autentizaci pro všechny neveřejné endpointy. Health liveness může být veřejný v lokálním režimu, readiness/dependencies mohou být omezené podle prostředí.

## COP API

Publisher používá bearer token jako baseline a návrhově podporuje mTLS/OIDC client credentials. `X-Source-System-Id`, `X-Contract-Version`, `X-Idempotency-Key` a `X-Correlation-Id` jsou povinné integrační hlavičky.

## Audit

Auth selhání a změny auth konfigurace se auditují bez ukládání tajných hodnot.
