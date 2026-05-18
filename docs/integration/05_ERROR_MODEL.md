# Error model

**Status:** Baseline dokumentace

## Standardní tvar

Chyby se vrací v objektu `error` s poli `code`, `message`, `details` a `correlationId`. Stejný tvar používají SIM API i mock COP endpoint, pokud je to praktické.

## Kódy

- `VALIDATION_ERROR`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `SOURCE_REVOKED`
- `CONFLICT`
- `INTERNAL_ERROR`
- `DEPENDENCY_UNAVAILABLE`

## Práce s chybou

Publisher ukládá poslední chybu do queue záznamu, zvyšuje metriky a rozhoduje o retry/DLQ podle typu chyby.
