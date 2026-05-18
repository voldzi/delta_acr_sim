# Versioning policy

**Status:** Baseline dokumentace

## Kontrakt

- Aktuální verze je `cop-ingest-v1`.
- Verze je posílaná v `X-Contract-Version` a v payload `contractVersion`.
- Breaking changes vyžadují novou verzi, ADR a migrační plán.
- Non-breaking additions musí být volitelné a dopředně kompatibilní.

## Aplikace

SIM moduly používají semver. Publisher `adapterVersion` se zapisuje do source metadat každého eventu.

## Schémata

JSON Schema změny se posuzují podle dopadu na validaci existujících payloadů. Zpřísnění požadavků je breaking change.
