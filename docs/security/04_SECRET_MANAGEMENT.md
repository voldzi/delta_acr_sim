# Secret management

**Status:** Baseline dokumentace

## Pravidla

- Žádné secrets v repozitáři.
- Secrets se načítají přes environment nebo secret store.
- Logy a audity ukládají pouze reference nebo hash, nikdy hodnotu secretu.
- Rotace tokenu nesmí vyžadovat změnu kódu.
- `TPEG2_API_TOKEN` je upstream serverový credential: smí být pouze v chráněném
  produkčním prostředí situation-data-api. Nesmí se objevit v katalogu,
  normalizovaných features, URL logu, chybové odpovědi ani v raw projekci.
- Externí AI API klíče lze vypnout odstraněním konfigurace.

## Konfigurační typy

- COP bearer token nebo client credentials.
- Per-backend `GEO_ROUTING_SERVICE_TOKENS`; provision and rotate each actor
  independently and never place a real value in `.env.example` or OpenAPI.
- mTLS certifikáty, pokud budou použity.
- OpenAI/API provider credentials.
- Lokální LLM runtime konfigurace bez tajných hodnot, pokud možno.
