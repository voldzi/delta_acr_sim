# Acceptance criteria

**Status:** Baseline dokumentace

## Funkční

- SIM běží samostatně mimo COP
- UI umožní vytvořit, spustit, pozastavit a zastavit scénář
- SIM generuje aircraft, UAV a missile tracks
- SIM umí dry-run
- všechna data jsou SYNTHETIC
- fault injection je dostupný
- health/metrics endpointy fungují

## AI

- provider abstraction pro OpenAI, Codex, local LLM a mock
- AI draft validovaný proti JSON Schema
- human confirmation před spuštěním
- zakázané požadavky odmítnuté a auditované
- externí AI lze vypnout

## Integrace

- sourceSystemId
- idempotency key
- retry/backoff
- batch sending
- 401/403/409/422/429/503 handling
- revokace zdroje bez změny kódu

## Výkonnost

- 1 000 aktivních tracků MVP
- 1 000 zpráv/s lab režim
- queue neztratí data při krátkodobém výpadku
- restart neztratí uložené scénáře
