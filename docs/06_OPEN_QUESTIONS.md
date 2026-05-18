# Otevřené otázky

Autoritativní zadání `docs/zadani_codex_simulacni_system_ai_v1.md` bylo nalezeno a použito jako hlavní zdroj baseline.

## Integrace s COP

- Jaký bude finální base URL formát pro COP ingest prostředí v dev, test a lab režimu?
- Bude COP ingest preferovat bearer token, mTLS, OIDC client credentials, nebo kombinaci podle prostředí?
- Jaké budou finální rate limity, batch size limity a maximální payload size pro `cop-ingest-v1`?
- Má COP vracet `409` pro duplicitní idempotency key vždy, nebo pouze při odlišném payload hash?
- Jaký je přesný slovník klasifikačních úrovní, releasability a handling caveats mimo povinné `SYNTHETIC`?

## Implementace SIM

- Bude MVP používat SQLite, PostgreSQL, nebo jiný store pro scénáře a persistent publisher queue?
- Jak dlouho se mají uchovávat event payload previews, AI audity a publisher odpovědi?
- Jaké SLO/SLA hodnoty jsou očekávané pro generování 1 000+ zpráv/s v laboratorním režimu?
- Jaký lokální LLM runtime je preferovaný pro local-only režim?
- Budou demo scénáře verzované jako JSON soubory v repozitáři, nebo spravované přes aplikaci?

## UI a provoz

- Jaká autentizace bude použita pro samotné SIM UI v lokálním, testovacím a laboratorním prostředí?
- Má publisher monitor zobrazovat celý payload, nebo pouze redigovaný preview podle role?
- Má být okamžité zastavení publikace dostupné všem operátorům, nebo jen `SIM_ADMIN` a `SIM_OPERATOR`?
