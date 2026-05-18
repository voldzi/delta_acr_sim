# Connecting to COP

**Status:** Baseline dokumentace

## Předpoklady

- COP base URL
- auth konfigurace
- sourceSystemId registrovaný v COP
- contractVersion `cop-ingest-v1`
- rate limit a batch limit potvrzený COP týmem

## Postup

- spustit test connection
- odeslat sample event v test režimu
- ověřit correlationId v COP odpovědi
- spustit malý scénář
- sledovat retry a latency metriky

## Fallback

Při 401/403 nebo SOURCE_REVOKED okamžitě zastavit publikaci a ověřit konfiguraci. Queue nemazat bez rozhodnutí administrátora.
