# Secret management

**Status:** Baseline dokumentace

## Pravidla

- Žádné secrets v repozitáři.
- Secrets se načítají přes environment nebo secret store.
- Logy a audity ukládají pouze reference nebo hash, nikdy hodnotu secretu.
- Rotace tokenu nesmí vyžadovat změnu kódu.
- Externí AI API klíče lze vypnout odstraněním konfigurace.

## Konfigurační typy

- COP bearer token nebo client credentials.
- mTLS certifikáty, pokud budou použity.
- OpenAI/API provider credentials.
- Lokální LLM runtime konfigurace bez tajných hodnot, pokud možno.
