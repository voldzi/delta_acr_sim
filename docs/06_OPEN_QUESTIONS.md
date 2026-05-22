# Otevřené otázky

Tento seznam drží jen otázky relevantní pro další provoz SIM jako veřejně dokumentovaného providera.

## Integrace s COM

- Jaký bude finální název a governance model centrální aplikace COM mimo aktuální implementaci COP?
- Kdy COM backend přejde ze starších `/cop/*` provider aliasů na neutrální `/features` a katalogové streamy?
- Bude COM pro partnery preferovat bearer token, mTLS, OIDC client credentials, nebo kombinaci podle prostředí?
- Jaké budou finální rate limity, batch size limity a maximální payload size pro syntetický publisher ingest?
- Jaký je přesný slovník klasifikačních úrovní, releasability a handling caveats mimo povinné `SYNTHETIC`?

## Provider API

- Jaký bude stabilní registry proces pro nové `providerId`, `recommendedCatalogLayerId` a `styleProfile`?
- Které husté vrstvy přejdou jako první z bbox GeoJSON na MVT nebo raster tiles?
- Jak se bude verzovat Map Catalog Provider Contract po přidání tile streamů?
- Jak dlouho se mají uchovávat provider preview payloady, AI audity a publisher odpovědi?

## UI a provoz

- Jaká autentizace bude použita pro samotné SIM UI v lokálním, testovacím a laboratorním prostředí?
- Má publisher monitor zobrazovat celý payload, nebo pouze redigovaný preview podle role?
- Má být okamžité zastavení publikace dostupné všem operátorům, nebo jen `SIM_ADMIN` a `SIM_OPERATOR`?
