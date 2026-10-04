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

### Typed mapped profiles

ADR0033 řeší profile downgrade, vynechání voleb, záměnu jednotek/celkové
soupravy, forged assessment, engine clamp a fiktivní last-mile. Strict schema
bez coercion a unknown keys, whole-combination checks, přesný engine3.8.3,
warnings=reject a route/feature/profile/query/geometry/deadline binding jsou
nutné spolu s ADR0032. Driver declaration není blanket ignore_access.
Missing actual dimensions, trailer-only bans/turning clearance, neznámé
OSM omezení a nemapovaný poslední úsek mají explicitní limitations. Endpoint
musí zůstat na native geometry, ne na připojené přímce. COP kontroluje stejné
fences pro všechny variants a nesmí po chybě vybrat implicitní car/MapKit.
Klientská deklarace ani canonical hash neprokazuje právní oprávnění vjezdu.
Měření shadow_only a serverové secrets se nemění.

### Partial known closures

ADR 0032 nezakládá úplnou bezpečnostní garanci. Hrozby: falešné both ze směrově
neznámé fuzzy line, záměna cache confirmation za event onset, withdrawal z
neúplného XML, engine ignorující polygon, variant escape mimo OD a source/graph
race. Mitigace: fullRepository bounded parse s jednoznačnou identity/cancel,
individuální graph-bound semantic review, samostatný conservative reason,
celý native request + nezávislá geometrie všech variants/legs, 25m snap,
10min deadline, dvojí snapshot/status fence a no cache/no fallback.
COP nezávisle váže identity/hashes/features; provider původ a ruční review
zůstávají povinností provozního vlastníka. Public Git nesmí obsahovat raw TEC.

Mechanická návaznost ADR 0032 nezmění schválené source semantics/polygon ani
schvalovací soubor. Vyžaduje server-owned anchors a identitu stejného OSM
objektu v obou směrech; constrained variants mají navíc nezávislý edge_walk
zákaz tohoto objektu i mimo polygon. Finální source/graph/file fences,
deduplikace, omezená RAM vazba a 60s failure cooldown brání neověřenému přenosu
schválení i opakovanému zatěžování engine. Bez úspěchu zůstane 503 a lidská
revize. Samotný syntetický test ani test starého grafu není přijetí nové mapy.

Viz [ADR 0031](../adr/0031_IMMUTABLE_FAIL_CLOSED_ROAD_TRIPS.md). Client trip ani
atestace nesmí vytvořit autoritativní uzavírku. Closure source je oddělený,
server-owned, graph-bound a time-limited; chyby/expiry/změny invalidují všechny
varianty. Geometrické hashes prokazují identitu, nikoli právní průjezdnost.
Mapped restrictions, polygon coverage a neznámá OSM data mají explicitní
omezení. Trailer/axle/vjezd bez přijatého mechanismu odmítnout. Při 422/503
COP/SDK nesmí zahodit snapshot a použít MapKit nebo neomezenou legacy trasu.
Žádná změna privacy měření, intake nebo traffic writeru.
