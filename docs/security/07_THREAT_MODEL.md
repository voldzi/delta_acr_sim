# Threat model

**Status:** Baseline dokumentace

## Aktiva

- publisher credentials
- scenario store
- publisher queue
- AI prompts and drafts
- audit logs
- COP ingest contract
- runtime controls

## Hrozby

- únik secretů
- odeslání nevalidních nebo nesyntetických dat
- prompt injection proti AI guardrails
- zneužití live publisheru
- replay bez idempotency
- ztráta queue při restartu
- přetížení COP ingest API
- neoprávněné clear queue nebo změna konfigurace
- podvržený nebo mutable Valhalla image či mapový vstup
- zastaralý nebo částečně aktivovaný routing dataset
- vyčerpání disku během mapového buildu

## Mitigace

- secret management mimo repo
- schema validation
- synthetic marking gate
- role-based permissions
- audit
- idempotency keys
- persistent queue
- rate limiting
- dry-run default pro lokální vývoj
- human-in-the-loop pro AI
- pinovaný Valhalla digest, source checksumy a release provenance
- build mimo produkci, hard-snap acceptance matrix a atomický release pointer
- validovaný rollback, file lock, disk gate a omezení build prostředků

## Zbytkové riziko

Finální rizika závisí na zvoleném auth modelu, store, retenci auditů a runtime prostředí. Tyto body jsou otevřené otázky před produkční implementací.
