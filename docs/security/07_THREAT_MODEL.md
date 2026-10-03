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

## Immutable road trip boundary

Viz [ADR 0031](../adr/0031_IMMUTABLE_FAIL_CLOSED_ROAD_TRIPS.md). Client trip ani
atestace nesmí vytvořit autoritativní uzavírku. Closure source je oddělený,
server-owned, graph-bound a time-limited; chyby/expiry/změny invalidují všechny
varianty. Geometrické hashes prokazují identitu, nikoli právní průjezdnost.
Mapped restrictions, polygon coverage a neznámá OSM data mají explicitní
omezení. Trailer/axle/vjezd bez přijatého mechanismu odmítnout. Při 422/503
COP/SDK nesmí zahodit snapshot a použít MapKit nebo neomezenou legacy trasu.
Žádná změna privacy měření, intake nebo traffic writeru.
