# Retry and backoff

**Status:** Baseline dokumentace

## Retryable stavy

- Síťová chyba nebo timeout.
- `429 RATE_LIMITED`.
- `500`, `502`, `503`, `504`.
- Dočasná nedostupnost mock/COP endpointu.

## Non-retryable stavy

- `400 VALIDATION_ERROR`.
- `401 UNAUTHORIZED`.
- `403 FORBIDDEN` nebo `SOURCE_REVOKED`.
- `422` schema nebo business validation error bez opravy payloadu.

## Algoritmus

Baseline používá exponential backoff s jitterem, maximálním počtem pokusů a respektováním `Retry-After`. Stav retry se ukládá per event v persistent queue.

## Bezpečnost

Retry nesmí změnit payload, eventId, producerTimestamp ani idempotency key původního eventu.
