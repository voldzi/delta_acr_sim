# Příprava napojení ochrany účtu do SIM

Aktuální DBv2 cesta je v [ADR0040](../adr/0040_DATABASE_BACKED_ACCOUNT_ERASURE.md)
a [runbook20](../runbooks/20_DATABASE_ERASURE_ACCEPTANCE.md). Níže zachovaný
Root/native návrh a jeho neměnné důkazy se k této cestě nepřičítají a jejich
další dokončování není její podmínkou. DBv2 má konkrétní PG guard, skutečný
replay, transakční fences a výslovnou správu obnovy, ne kladné porty.

Přípravný krok pro COP Router a dobrovolná měření vychází ze zdroje
`25de85abf2ab00ad125c9482f1ddb70bb81cfce2`. Přesné HTTP kontrakty a
transakční ochrany existují; chybí skutečné nativní napojení jejich
operací na přijatou autoritu. Tento plán vymezuje soubory a hranice další
zdrojové změny. [Neaktivní instalační manifest](23_SIM_ACCOUNT_SAFETY_INACTIVE_INSTALL.json)
je inventář k revizi, nikoli installer nebo nové wire schéma. Předchozí
inventář z revize `03f5408` zůstává beze změny v
[archivu](../archive/2026-10-14_SIM_ACCOUNT_SAFETY_INACTIVE_INVENTORY_03f5408.json).
Ověření dokončeného lokálního úklidu je v
[testovacím záznamu](../archive/2026-10-14_DRIVER_RETENTION_LIFECYCLE.md).

## Chráněné čtení skutečného stavu měření

### Vazba ETA na přispěvatele dávky

Původní ETA cizí klíč kontroluje pouze `(owner, batch_id)`, nikoli shodu
denního contributor hashe s rodičovským receipt. Inventura SQL006 přitom
správně zahrnuje také vlastní ETA hash. Při historickém nesouladu by
mazání receipts podle hashe mohlo ponechat ETA a nesprávně potvrdit nulu.

Oddělený forward zdroj `007_eta_contributor_binding.sql` proto přidává
receipt UNIQUE `(owner, batch_id, contributor_hash)` a nahrazuje původní
ETA FK stejnou trojicí. Vazba je validovaná, immediate/nondeferrable
a zachovává ON DELETE CASCADE i přesně dva receipt cascades pro reader004.
Pod omezenými table locks nejprve ověří původní katalog i všechna data;
orphan nebo jiný contributor hash odmítne SQLSTATE 23514 před DDL.
Nikdy nepřepisuje hash, nemaže cizí rodičovskou dávku ani neopravuje
historická data automaticky. Existující nesoulad vyžaduje samostatné
rozhodnutí správce. Nový skutečný schema fingerprint musí nezávisle
přijmout Root policy; není oprávněním převzít aktuální hash z DB.
Zmrazené SQL003, SQL006 a jejich historické důkazy se tím nepřepisují.

Samostatné [ověření SQL007](../archive/2026-10-15_SOURCE_REFRESH_AND_ETA_BINDING.md)
prošlo 6/6 skupinami včetně skutečného FK souběhu oběma směry. Neprokazuje
Root enrollment nebo produkční mazání.

### Chráněná fakta pro admission

Privátní `004_read_admission_facts.sql` přidává
`sim_driver_guard_source.read_admission_facts(jsonb)`. EXECUTE dostává
pouze existující `sim_driver_guard_control`, nikoli runtime, executor
nebo PUBLIC. Nevytváří role, hesla ani enrollment. Vyžaduje
`BEGIN READ ONLY`, pevný `session_user`, UTC a `search_path=pg_catalog`.
Funkce je STABLE, nezapisuje a nevolá origin probe, seal ani explicitní
row/advisory lock. Veřejný OpenAPI kontrakt se nemění.

Request obsahuje přesně `owner=sim_driver_measurements`,
`scope=online_driver_scope` a `purpose`. `capability|intake` nepřijímají
identitu; `preflight|status|receipt` navíc vyžadují oba lowercase hex64
`operationHash` a `actorHash`. Neznámé klíče nebo špatná struktura končí
SQLSTATE 22023. Cizí actor a neexistující operace mají shodně
`operation:null`. Výstup `sim-driver-read-facts-v1` nese skutečnou
inkarnaci, checkpoint/proof/report stav, schema/privilege fingerprint
a nejvýše jeden přesný scalar ledger readback. Nevrací contributor
inventory, manifest, GPS, raw SQL ani account→day vazbu.

Fingerprint je PG SHA-256 UTF-8 `jsonb::text`, nikoli JavaScript JSON hash.
Schema core `sim-driver-schema-fingerprint-v1` zahrnuje sedm tabulek,
definice, indexy, constraints, triggery a původní receipt guard.
Privilege core `sim-driver-privilege-fingerprint-v1` zahrnuje pevné role,
členství, ACL, účinná práva včetně PUBLIC column grantů a skutečné privátní
funkce. NULL a explicitní prázdné ACL nejsou stejný pin. `ledgerDigest`
je zvláštní PG SHA-256 celého skutečného řádku ledgeru v UTC. Očekávané
piny přijímá nezávislý Root publisher; nezískávají autoritu tím, že je
vrátí samotná kontrolovaná DB.

### Skutečný Root reader a přesný permit

`read-admission-facts.mjs` je pouze čistá validace pozorování a nezbytných
podmínek. Skutečný `root-read-admission.mjs` patří jako obyčejný Root-owned
soubor vedle připnutého COP `root-records.mjs` pod `/opt/cop-account-safety`.
Pevné soukromé profily `registry-probe` a `driver-control` používají
ověřenou TLS CA/server name. Volající nevybírá DSN, cestu, klíč ani callback.
Broker volá `inspectRootDriver(readPermitId, request, peer)`; peer pochází
výhradně z nativního kernelového transportu COP, ne z HTTP.

Root čte `/run/cop-account-safety/private/read-permits/<UUID>.json`, kind
`driver-read-permit`. K běžným pěti polím Root recordu přidává přesně:

```text
request, requestDigest, guardStoreId, continuityEpoch, datasetBindingId,
runtimeBindingId, sourceProofId, policyGeneration, frontierSequence,
frontierDigest, storeIncarnation, expectedCheckpointHash,
expectedSchemaFingerprint, expectedPrivilegeFingerprint,
reportProtection, reportInventoryRef, evidence
```

`requestDigest` je SHA-256 plochého kanonického JSON requestu se seřazenými
klíči, bez newline. `evidence` má přesně čtyři `{recordId,digest}` reference
s kinds `driver-read-identity`, `driver-read-retention`, `driver-read-report`
a `driver-read-schema`. Každá podepsaná evidence má kromě běžného Root
základu přesně:

```text
readPermitId, requestDigest, owner, scope, guardStoreId, continuityEpoch,
datasetBindingId, runtimeBindingId, sourceProofId, storeIncarnation,
policyGeneration, frontierSequence, frontierDigest, decision
```

Rozhodnutí v tomto pořadí jsou `cop-jizda-owned-sim-preserved`,
`bounded-read-permitted`, `verified-report-inventory` a
`exact-read-facts-policy-verified`. `reportInventoryRef` odkazuje na kind
`driver-report-inventory`: stejný základ a navíc `reportProtection`,
`checkpointHash`, `schemaFingerprint`, `privilegeFingerprint`. Rozhodnutí
je `verified-no-derived-publication` pro `no_report`, jinak
`verified-derived-barrier`. Inventuru musí skutečně přijmout COP publisher;
prázdný dotaz ani DB boolean nevytvoří `no_report`.

Reader před i po skutečném read-only SQL ověřuje skutečné Ed25519 podpisy,
nezávislý aktuální frontier, boot, cluster/timeline, živou registry,
owner/dataset/runtime/proof/policy a peer. Neshoda s permit piny nevydá
admission. Dotazy mají klientský i serverový timeout a celá operace
15sekundový watchdog včetně cleanup; výpadek nemá SQL fallback.

Aktuálně dohodnutý privátní Root layout je
`/run/cop-account-safety/private/{read-permits,ai-read-permits,read-deliveries,ai-read-deliveries,read-evidence,request-contexts,maintenance-deliveries,owner-authority,runtime-observations}`.
Vše musí být Root-only 0700 na explicitním tmpfs. Čtyři per-read evidence
Driver/AI i Driver read inventory používají `read-evidence`; stará
`/var/lib/cop-account-safety/evidence` zůstává jen pro trvalé immutable
mutation evidence a ACK inventory. Starý soubor nesmí nahradit chybějící
privátní read evidence/permit. Krátké TTL nebo pozdější unlink na SSD
nejsou totéž jako neretenční úložiště.

Do app kontejneru patří jen konkrétní socket a veřejný bootstrap/keyring
adresář, nikdy celý `/run/cop-account-safety`, ani když app běží jako
UID 0. Nový service epoch musí projít skutečným peer/cohort drain a
enrollmentem; absence souboru po restartu není důkaz quiescence.
Host runtime pozorování publikuje samostatný Root watcher do pevné
`runtime-observations/<owner>.json`: podepsaný kind
`host-runtime-observation`, přesně základ Root recordu a `observation`,
platnost nejvýše 5 s. Watcher pozoruje skutečný proces a konfiguraci,
ale nepřijímá image/policy, nemění Docker a nezřizuje enrollment.
Broker nemusí dostat administrátorský Docker socket; čte pouze tento
chráněný aktuální fakt. Fakt sám není přijatou source/replay autoritou.

### Pevný Root owner common protokol — neaktivní zdroj

`deploy/account-safety/root-owner-authority.mjs` a jeho čistý
`root-owner-authority-protocol.mjs` definují skutečnou pevnou autoritu,
nikoli pozitivní callback dodaný aplikací. Exporty jsou
`requireCurrentOwner`, `holdOwnerLease`, `issueOwnerEphemeralRecord`,
`beginOwnerPublicationIntent`, `requirePublicationBarrier` a samostatný
`refreshRootOwnerSource`. Kontroly COP
aktéra se přebírají z připnutého chráněného COP modulu. Import vyžaduje
celý revidovaný souborový uzávěr v `/opt/cop-account-safety`; samotná
typová deklarace nebo přítomnost jednotlivého souboru není instalace.

Kontext `cop-root-owner-authority-v1` má přesně 22 polí:
`contractVersion`, `owner`, `scope`, `purpose`, `registration`, `peer`,
`guardStoreId`, `continuityEpoch`, `protectedConfigId`, `datasetBindingId`,
`runtimeBindingId`, `sourceProofId`, `policyGeneration`, `frontierSequence`,
`frontierDigest`, `storeIncarnation`, `expiresAtUTC`, `reference`,
`rootPolicy`, `keys`, `assertCurrent`, `close`. Jeho skutečnost se drží
v privátním WeakMap; kopie stejných polí se za kontext nepřijímá.

| Účel | Skutečně držená metadata session |
| --- | --- |
| Driver `read`, AI `checkpoint-read` | Sdílený advisory zámek `(hashtext(current_database()),904214)` |
| `mutation`, `publication`, `retention`, `checkpoint-publish`, `source-refresh` | Exkluzivní protějšek stejného zámku |

Autorita porovnává aktuální registry, globální politiku, frontier,
source JWS, podepsanou owner policy, přesný schema/privilege fingerprint,
inkarnaci databáze a skutečný vlastní Root proces. Jeho pidfd identita,
start ticks, boot a hash běžícího executable se před databází i před/po
ověření porovnají s čerstvým podepsaným host pozorováním. Záznam jiné
Root instance nelze převzít jen proto, že ještě nevypršelo jeho 5 s.

Historický důkaz P0, skutečný replay/receipt a checkpoint acceptance
navazují na aktuální source P1. Důkazy P0 a P1 mají různá ID. Shodná
`ownerPolicyRef` zůstává základní cestou; odlišné reference vyžadují úplnou
ověřenou návaznost původní politiky A, jejího předem podepsaného přechodu T
a aktuální politiky B. Pouhá platná struktura reference nestačí.
Podepsaný acceptance artefakt obsahuje SHA-256 skutečných úplných
PostgreSQL JSONB řádků acceptance/receipt/replay v UTC.

Samotný source `refresh` nesmí vytvořit nový checkpoint acceptance.
Metadata rozlišují obnovení důkazu od samostatně přijatého replay/nasazení.
P0 pro nový checkpoint proto musí patřit příslušné schválené operaci
`deployment`, `restore`, `rollback` nebo `enrollment`; první testovací
přechody zde používají výslovné syntetické checkpoint `deployment`.
Aktuální následný P1 může být běžný `refresh`. Omezení metadata SQL se
kvůli této cestě nerozšiřuje.

Soukromý helper `verifyOwnerPolicyLineage({owner,binding,priorRef,currentRef})`
čte pouze pevné Root cesty. Ověřuje originál A v
`/var/lib/cop-account-safety/owner-policy-history/<recordId>.json`, aktuální B,
všech pět důkazů každé politiky, podpis přechodu a jeho původní neměnný
intent i dispatch. Obě politiky musí mít stejné globální/databázové vazby
a schema/privilege piny. Driver navazuje nenulový předchozí hash na přesný
nový hash; AI zachovává operation/schema digests a zvyšuje textovou bigint
generaci přesně o jedna. Nový přechod v B musí mít jiné ID i referenci T.
Prvotní Driver přechod z `null` tato odlišná historická cesta nepřijímá.

Výstup helperu není autorita. Skutečný common navíc ověřuje historický
P0 a aktuální P1 ve stejné procesní kohortě, cluster/timeline, frontier,
aktuální globální politice a všech osmi binding polích. P0 musí odkazovat
na skutečný předchozí acceptance C1; ten se kontroluje proti podepsanému
artefaktu a původním úplným PG row digestům. Aktuální C2 i jeho receipt
musí mít tentýž předchozí C1 a přesnou generaci C1 + 1. Původní intent
a dispatch musely vzniknout za platnosti P0 a jeho neměnný deadline
nesmí překročit expiraci P0. Všechny bigint projekce zůstávají textové;
digesty se stále počítají nad nezměněným původním PG JSONB řádkem.

Každý běžný účel vyžaduje přesný aktuální cílový checkpoint a readiness;
Driver navíc skutečný nevypršený target proof. Výhradně `checkpoint-publish`
smí při exkluzivním zámku provést předem podepsanou opravu přesně určeného
vypršeného či karanténního předchozího stavu. Po zápisu musí odpovídat
přesnému T a skutečnému původnímu intent/dispatch. Totéž dovolí další
schválený přechod B na C; žádný třetí libovolný stav se nepřebírá.

Expirace oprávnění odmítne práci, ale sama neodemkne session. `close()`
čeká na skutečné ukončení a souběžní volající sdílejí stejný výsledek.
Nejasná SQL/session odpověď vyvolá process-global HOLD; ztracený PG zámek
ani následný reconnect jej nesmí automaticky vymazat. Nová Root instance
musí mít samostatně přijatou novou kohortu a doložený drain.

`root-owner-read.mjs` skládá existující skutečné SQL/crypto readery a
vydává jen krátké typované záznamy do soukromého tmpfs. Checkpoint writer
`root-owner-checkpoint.mjs` ukládá neměnný intent i dispatch claim před
setterem. Ještě před nimi `archiveCurrentOwnerPolicy(ctx)` pod skutečným
WeakMap kontextem `checkpoint-publish` uloží přesné původní bajty politiky
pomocí O_EXCL a fsync do předem zřízené Root-only složky 0700. Existující
originál musí být bajtově shodný; nelze jej přepsat, obnovit či vyrobit
ze stavu databáze. Po prvním claimu smí writer pouze ověřit stejný původní stav; nesmí
obnovit deadline, UUID nebo tělo. Jeho stav `checkpoint-readback-known`
není potvrzení původního COMMIT ani přijetí nové Root policy.

Tento společný modul sám neprokazuje, že všechny produkční mutation,
publication, retence a HTTP odpovědi skutečně drží zámek až do drain.
Před aktivací je nutné společně připojit a otestovat skutečné executory
a protistranu COP. Obnovení starého obrazu, který common ignoruje, musí
zablokovat nezávislá chráněná startup/publish karanténa ještě před
zpřístupněním dat; zákaz rollbacku pouze v textu nestačí. Produkční
Root instalace, přijetí skutečných politik a obnova po HOLD zůstávají
samostatnými neuzavřenými gates. Veřejný OpenAPI se tímto soukromým ABI
nemění.

### Obnovení aktuálního source proofu

`refreshRootOwnerSource(owner, peer)` vytváří jediný nový podepsaný
runtime proof, pouze dokud původní autorita stále platí. Volající nepředává
UUID, tělo, profil, cestu ani callback. Pevný Root profil
`registry-source-refresh` vybírá výhradně databázi
`cop_account_safety_guard` a omezený účet `cop_guard_source_refresher`.
Nová SQL migrace `deploy/account-safety/004_source_refresh_cas.sql` je
neaktivní zdroj; vytváří NOLOGIN role, nikoli produkční přihlašovací účet.
Reader `cop_guard_root_reader` nezískává právo zápisu ani spuštění RPC.

Původní kontext má stále stejných 22 neměnných polí. Nový proof neobnovuje
jeho deadline, frontier anchor, registraci procesu, cílový checkpoint ani
Driver target proof. Nenahrazuje enrollment, přijetí nové politiky nebo
opravu vypršené autority. Root před zápisem ověří úplný současný stav,
stejnou procesní kohortu, podpisy, frontier a skutečné cílové piny.
Novou platnost omezí původní registrace a anchor a nejvýše 30 sekund
od skutečného pozorování; budoucí pozorování není přijatelné.

Privátní SQL volání je pevně
`SELECT cop_guard.refresh_runtime_proof($1::jsonb) AS value`. Tělo má
přesně `contractVersion=cop-root-source-refresh-cas-v1`, `owner`,
`binding`, `expected`, `refresh`; neznámá pole se odmítnou. Všech osm
binding hodnot, patnáct expected hodnot a sedm refresh hodnot jsou řetězce.
SQL `policyGeneration` je kanonický desetinný řetězec; tím se nemění
samostatný podepsaný JWS kontrakt. Přesné názvy a chybové SQLSTATE jsou
závazně vypsané v hlavičce SQL004. `expected` zahrnuje úplné původní
PG/UTC row digesty identity, globální policy, datasetu, runtime, současného
proofu, acceptance, receipt, replay a historického receipt source proofu,
jejich ID/generace a přesný frontier. Tyto digesty se nepřepočítávají
z JavaScriptem znovu zakódovaného JSON.

Root ukládá nové JWS, podepsaný původní intent a dispatch přes O_EXCL
a fsync před jediným RPC. SQL vyžaduje tutéž fyzickou session se skutečně
drženým exkluzivním zámkem 904214, READ COMMITTED a READ WRITE. Přidává
jediný `refresh` řádek; nemění checkpoint, politiku, replay nebo receipt.
ALWAYS BEFORE INSERT trigger stejným zámkem serializuje všechny insertery
runtime proofů včetně původního enrolleru. Kontrola `pg_locks` sama
nedokazuje Root WeakMap kontext ani správný životní cyklus zámku.

Před COMMIT i po potvrzení musí stále platit původní deadline. Dvě úplná
čtení potvrzeného stavu navíc ověří přesný nový JWS, operation ID, časy
a digest vloženého řádku; ostatní původní stav zůstává beze změny. Výsledek
`refresh-readback-known` je dílčí potvrzený readback, ne readiness nebo
nový autorizační kontext. Ten lze získat až po známém uzavření původní
session a novém úplném ověření.

Timeout nebo neznámý výsledek po dispatch přepne proces do HOLD a zachová
původní ID a tělo. Patnáctisekundový watchdog nesmí zavřít metadata socket
držící nezávislou bariéru. Neexistuje automatický retry, nová lhůta,
reconnect ani odemknutí podle TTL. Dohledání původního refresh originu
po restartu, drain a přijetí nové kohorty zůstávají samostatnou
neuzavřenou podmínkou před produkčním zapnutím této cesty.

Samostatně prošel [SQL CAS 8/8 a Root integrační sada 6/6](../archive/2026-10-15_SOURCE_REFRESH_AND_ETA_BINDING.md).
Root sada používá skutečné podpisy/TLS/zámky, ale syntetické přijaté
metadata a host/app pozorování. Neověřovala ztracený COMMIT, nejasný END,
nativní packet transport, produkční enrollment nebo obnovu.

Samostatný skutečný izolovaný common běh **22/22** a přesné rozdíly mezi
skutečnými a syntetickými podklady dokládá
[záznam z 15. 10. 2026](../archive/2026-10-15_ROOT_OWNER_AUTHORITY.md).
Nedokládá checkpoint writer, native transport ani produkční restore.

Nová [samostatná sada historie politik](../archive/2026-10-15_ROOT_OWNER_POLICY_LINEAGE.md)
prošla 8/8 skupinami se skutečným Driver/AI checkpoint writerem a SQL005,
včetně navazujícího Driver přechodu, chybných podkladů a nesprávného cíle.
Politiky, host a enrollment jsou syntetické; skutečný producer, native
transport a produkční restore zůstávají oddělené podmínky aktivace.

Historické Root14/16 testy níže používaly původní layout a nejsou
přičítány jako důkaz této nové cesty. Samostatná
[kontrola nového layoutu](../archive/2026-10-15_ROOT_READ_EVIDENCE_LAYOUT.md)
prošla 10/10 novými případy nad skutečnými Root podpisy, TLS a PostgreSQL.
Jde pouze o layout readerů se syntetickým peerem; produkční tmpfs/installer,
společná owner autorita, native transport a obnova zálohy nejsou přijaty.

Výstup je `{admission,record}`: existující
`sim-driver-guarded-read-admission-v1` a inline kanonický podepsaný kind
`driver-read-admission`. Jeho reference váže SHA-256 přesných bajtů recordu
včetně newline. Record váže request/facts/ledger digests, peer/registraci
a všechny aktuální vazby a piny. COP klient musí ověřit podpis i korelaci.
Platnost je nejvýše pět sekund od pozorování, nikdy déle než permit,
evidence/inventura, registrace, frontier a runtime/target proofs.
Nevzniká trvalý per-read actor/day soubor. Výsledek nenahrazuje drženou
generation/read lease, drain, journal ani restore replay COP.

[14 skutečných PostgreSQL případů](../archive/2026-10-15_DRIVER_READ_ADMISSION_SQL.md)
ověřilo SQL fakta a zákaz vedlejších účinků.
[15 Linux integračních případů](../archive/2026-10-15_DRIVER_READ_ROOT.md)
ověřilo skutečné podpisy/custody/TLS/SQL readeru se syntetickými Root
záznamy a peer. Neprokazuje to produkční permit, nativní peer, enrollment
nebo obnovu skutečné zálohy.

Následná bezpečnostní revize zachovává při podpisu původní ověřený
keyring snapshot a ověřuje neměnnost keyring/signer bytes před i po něm,
shodně s AI readerem níže. Má [nový samostatný 16skupinový důkaz](../archive/2026-10-15_DRIVER_READ_KEYRING.md),
nikoli přepsané předchozí výsledky. Negativní signer/keyring případy
nedokládají deterministický race test rotace ani produkční config lease.

## Omezená publikace Root checkpointů

### Privátní ověření uchovaných kandidátů denní identity

Zdrojový `006_inventory_candidates.sql` přidává pouze
`sim_driver_guard_source.read_inventory_candidates(p_hashes jsonb)`.
Volající je pevný `sim_driver_guard_control` v `BEGIN READ ONLY`; PUBLIC,
runtime ani executor nemají EXECUTE. Funkce je STABLE SECURITY DEFINER pod
existujícím NOLOGIN ownerem, s pevným `search_path=pg_catalog`, UTC a
`row_security=off`. Nepřidává roli, sloupec, vazbu účtu na dny nebo nový
store binding. Chybějící přijatá inkarnace znamená nedostupnost.

Vstup je JSON pole 1–4096 unikátních lowercase hex64 řetězců, nejvýše
278528 bajtů kanonického PG JSONB textu. NULL, jiný tvar, duplicity,
neplatné hodnoty či překročení meze mají SQLSTATE 22023. Control bez
read-only transakce nebo bez předem existujícího bindingu má P0001;
neoprávněné role mají 42501. Caller musí nastavit omezený statement/lock
timeout; chyba se nesmí vykládat jako prázdná inventura.

Přesný výstup obsahuje jen:

```text
contractVersion = sim-driver-inventory-candidates-v1
observedAtUTC   = skutečný čas pozorování v kanonickém UTC
storeIncarnation = skutečný předem přijatý UUID
candidateCount  = počet vstupních kandidátů, nikoli počet nálezů
matchedHashes   = seřazený unikátní podvýběr předaných hashů
```

Čte pouze členství v COP receipts, ETA a dočasných/trvalých revokacích.
Vrací i prošlou, dosud uloženou dávku a receipt bez přijatých intervalů;
intervaly pokrývá původní receipt FK. ETA contributor může být odlišný od
parent receipt, proto má vlastní kontrolu. Nevydává nepředané hashe,
receipt JSON, GPS, dny, ledger nebo účet. Indexované zdrojové sloupce se
nepřetypovávají; validované vstupy se převádějí na `char(64)`.

Root musí sám odvodit kandidáty z ověřeného účtu a nezávisle přijaté
historie klíčů s doloženou mezí vydávání. Výsledek DB nedokazuje účet ani
úplnost historie. Root v RAM spojí nálezy s povinnými nedávnými dny a
skutečným COP outboxem. Přes 4096 kandidátů nebo 40 manifest položek se
nesmí tiše zkracovat. Nový EXEC a úzký ETA SELECT pro NOLOGIN ownera mění
privilege pin; jeho hodnotu nelze automaticky převzít z cílové databáze.

[12 skutečných izolovaných PG případů](../archive/2026-10-15_DRIVER_INVENTORY_CANDIDATES_SQL.md)
ověřilo tuto SQL funkci a neměnnost dat. Nejde o produkční instalaci,
Root derivaci, úplnou inventuru, obnovu nebo společnou akceptaci.

Čisté doménové moduly pod `deploy/account-safety/` připravují přesné
transientní JSON struktury pro skutečné Root pluginy; samy nejsou těmito
pluginy ani verifikátorem. Driver používá pevné sibling importy skutečného
compiled `driver-account-erasure.js` a `driver-revocation-actor.js`,
neduplikuje HMAC/parser/coverage pravidla. Připravuje revoke/erase/ACK/
expire těla; nevyrábí origin, cutoff, permit, accountMAC nebo `no_report`
autoritu. ACK kontext je jen strukturálně validovaný vstup, nikoli důkaz
podpisu, freshness, nezávislého inventory či bariéry.

AI `buildAiRootCheckpointBody(transition, previousFacts, now)` skládá
přesné třináctipolové SQL005 tělo z přesné čtrnáctipolové transition.
Skutečný Root common musí nezávisle ověřit její původ, referenci a
výhradní maintenance lease. Helper požaduje actual SQL004 snapshot,
schema/priv piny z transition, přesné bigint +1 a proof <=30 s. Rozlišuje
konzistentní předchozí active/quarantine stav, ale nepovažuje quarantine
facts za oprávnění aktivovat. Žádné ID nebo pin sám negeneruje/adoptuje.

Reprodukovatelné `node scripts/test-account-safety-owner-domains.mjs --run`
vyžaduje Node 24 a již sestavené, připnuté skutečné pure siblings. Staging
je izolovaný v `/private/tmp`, bez databáze, síťového volání či production
secrets a po běhu se smaže. **30 PASS jsou pouze pure wire/byte testy**,
nikoli Root publisher, native lease, restore nebo produkční akceptace.
Skutečné fixed Root pluginy, target profily a přijatý common authority ABI
zůstávají samostatnou nedokončenou integrační částí.

Následující dva soubory `005_root_checkpoint.sql` jsou oddělené zdrojové
publikátory metadat, nikoli produkčně aplikované migrace nebo přijetí autority.
Vyžadují předem existující pevné omezené role, přijatou inkarnaci v
privátním `store_binding` a existující singleton checkpointu. Nevytvářejí
role, členství, secrets, přístupové údaje, singleton ani automatickou vazbu úložiště.
Tabulky zůstávají vlastněné dosavadním migrátorem; běžná aplikace nedostává
EXECUTE, široký UPDATE ani nové oprávnění k mazání.

Root musí před voláním nezávisle ověřit skutečné podepsané aktuální
owner/continuity/replay a příslušné retenční, publikační či nákladové
podklady. SQL tyto podpisy neověřuje a z vlastních booleanů nevytváří
pravdivý důkaz. Přesný `rootRecordRef={recordId,digest}` obsahuje UUID a
lowercase hex64; je pouze dočasně přijat a vrácen, nikde se neukládá.
Jeho skutečný původ a nejisté doručení řeší chráněný Root journal.

Oba settery mají pevný `session_user`, `SECURITY DEFINER` pod NOLOGIN
ownerem, UTC, `row_security=off` a `lock_timeout=1000ms`. Zamknou předvazbu
store pro čtení a existující checkpoint pro zápis. Kanonický UTC důkaz s
milisekundami musí být po získání zámku budoucí nejvýše o 30 sekund a stále
platný po UPDATE. To není síťový deadline ani náhrada Root/client watchdogu.
Smí se použít pouze pod výslovnou aktuální maintenance/review autoritou;
setter se nevolá pro každý chat nebo běžný aplikační požadavek.

### Driver SQL 005

`deploy/driver-measurements/005_root_checkpoint.sql` přidává pouze
`sim_driver_guard_source.apply_root_checkpoint(jsonb)` pro existující
`sim_driver_guard_control` v DB `sim_driver_measurements`. Request má
přesně 12 polí:

```text
contractVersion=sim-driver-root-checkpoint-v1, owner=sim_driver_measurements,
scope=online_driver_scope, storeIncarnation, expectedPreviousCheckpointHash,
checkpointHash, proofValidUntilUTC, replayReady, retentionReviewed,
reportProtection, publicationFenceVerified, rootRecordRef
```

Checkpoint je hex64. `expectedPreviousCheckpointHash:null` je přijatelný
jen při skutečně null počátečním checkpointu; jinak musí přesně odpovídat
uzamčené dosavadní hodnotě. Aktivní režim vyžaduje všechny tři readiness
booleany true a chráněný report režim. Karanténa vyžaduje všechny false a
`reportProtection=unverified`; smíšené stavy se odmítají.

Owner dostane jen explicitní UPDATE sloupců `replay_ready`,
`replay_checkpoint_hash`, `proof_valid_until`, `retention_reviewed`,
`report_protection`, `publication_fence_verified`. Původní úzké
`UPDATE(singleton)` potřebné pro 003 share-lock zůstává beze změny.
Žádný ledger, origin, receipt, contributor fence, report ani store binding
se nemění. Čas důkazu se zapisuje do již existujícího `proof_valid_until`;
nevzniká nová TTL tabulka nebo vazba na účet.

Výsledek `sim-driver-root-checkpoint-result-v1` má přesně
`contractVersion`, `storeIncarnation`, `rootRecordRef`, `appliedAtUTC`,
`state`; poslední položka je skutečný sedmipolový readback odpovídající
Driver 004. Nejde o podepsané přijetí ani dokončení mazání.
[Samostatný záznam](../archive/2026-10-15_DRIVER_ROOT_CHECKPOINT_SQL.json)
dokládá 8/8 nových syntetických skupin na skutečném PostgreSQL 18.3:
ACL/kontrakt, CAS, karanténu, expiraci/zámek, souběh a metadata-only efekty.
Cluster byl pouze soukromý Unix socket a byl odstraněn. Tento důkaz
neobsahuje skutečný Root podpis, delivery, restore nebo nasazení a
nepřičítá starší 11/14/15/18 případy.

### AI Router: čtecí fakta 004

`deploy/ai-router/004_root_checkpoint_facts.sql` definuje
`sim_ai_guard_source.read_checkpoint_facts(jsonb)` v DB `sim_ai_router`.
Existující `sim_ai_guard_owner` je NOLOGIN, control je pevný
`sim_ai_guard_control`; runtime `ai_router_runtime` nemá privátní
USAGE/EXECUTE. Příprava vyžaduje prázdné vlastněné privátní schéma a
vytvoří prázdný `store_binding`, bez generované inkarnace či automatického
enrollmentu. Před setterem 005 musí být vazba zvlášť skutečně přijata.

STABLE reader vyžaduje `BEGIN READ ONLY`, nezapisuje a nespouští origin
probe, maintenance nebo poskytovatele. `search_path=pg_catalog,public`
zachovává dosavadní viditelnost definic pro legacy schema digest; všechny
relace jsou kvalifikované a runtime/guard/control nesmějí CREATE v public.
Request obsahuje přesně:

```text
owner=sim_ai_router, scope=cop_router_primary_database, purpose=checkpoint,
expectedSnapshot={checkpointId,generation,operationDigest,schemaDigest}
```

`generation` je kanonický nezáporný desetinný text v rozsahu PostgreSQL
bigint, nikoli JSON number. `sim-ai-checkpoint-facts-v1` vrací request,
čas a inkarnaci, `snapshotMatches`, schema/permission fingerprinty,
čtyři invarianty a nejvýše tento sedmipolový checkpoint:
`identity_reviewed`, `replay_ready`, `cost_policy`, `checkpoint_id`,
`checkpoint_generation`, `operation_digest`, `schema_digest`.
Nezveřejňuje jednotlivé účty, klíče, requesty ani finanční řádky.

Legacy operation/schema digests mají stejné PostgreSQL byte pravidlo jako
dosavadní Router; nejsou přepsány na JavaScript hash. Nové schema a
privilege fingerprinty zvlášť vážou skutečný katalog, RLS, fence triggery,
finanční invoker views, retenční pravidla, role a účinné column ACL.
`snapshotMatches` je pouze shoda faktů, ne Root oprávnění.
Čistý `checkpoint-facts.mjs` kontroluje přesný tvar a stáří nejvýše pět
sekund a znovu odvodí shodu snapshotu. Jeho samostatné testy prošly 10/10;
to není zkouška PostgreSQL, podpisu, peer transportu nebo produkční autority.

### AI Router: publikace metadat 005

`deploy/ai-router/005_root_checkpoint.sql` přidává pouze control-only
`sim_ai_guard_source.apply_root_checkpoint(jsonb)`. Pevný owner dostane
šest explicitních UPDATE sloupců `identity_reviewed`, `replay_ready`,
`cost_policy`, `checkpoint_id`, `checkpoint_generation`, `updated_at`;
tabulka zůstává vlastněná `ai_router_migrator`. Request má přesně:

```text
contractVersion=sim-ai-root-checkpoint-v1, owner=sim_ai_router,
scope=cop_router_primary_database, storeIncarnation, expectedCheckpointId,
expectedGeneration, checkpointId, generation, proofValidUntilUTC,
rootRecordRef, identityReviewed, replayReady, costPolicy
```

CAS porovnává skutečné ID i generaci. Nová generace musí být přesně stará
plus jedna, bez přeskočení, zaokrouhlení nebo bigint overflow. Aktivní režim
vyžaduje oba booleany true a `aggregate-costs-current-month-v1`; karanténa
oba false a `pending_requires_review`. Smíšené stavy jsou neplatné.

Výsledek `sim-ai-root-checkpoint-result-v1` má přesně `contractVersion`,
`storeIncarnation`, `rootRecordRef`, `appliedAtUTC`, `proofValidUntilUTC`,
`checkpoint`; checkpoint nese jen pět camelCase metadat
`checkpointId`, `generation`, `identityReviewed`, `replayReady`, `costPolicy`.
Operation/schema digests získá Root až novým čerstvým read-only čtením 004.
Na rozdíl od Driveru zde TTL není sloupec: deadline se jen ověří a vrátí,
nevytváří trvalou platnost readiness. Nemění se ledger, costs/rollups,
BYOK klíče, finanční views, RLS, fences ani billing pravidla.

Instalace kterékoli 005 změní skutečný privilege fingerprint funkcí a
sloupcových ACL. Root musí nezávisle přijmout nový pin; nesmí ho jen
převzít z kontrolované DB nebo obejít kontrolu shody. Staré piny musí
selhat uzavřeně, přestože správný úzký runtime profil zůstane zachovaný.

### AI Root reader a čerstvé per-inspect doručení

`deploy/ai-router/root-checkpoint-read.mjs` je zdrojový pevný Root reader,
nikoli už připojený produkční verifier nebo metadata setter.
`inspectRootAiCheckpoint(readPermitId, request, peer)` volá pouze COP
nativní broker; ten podle potvrzeného COP kontraktu vybírá právě čerstvý
permit z chráněného per-inspect delivery. Aplikace nesmí vybrat UUID permitu,
cestu, callback, DSN nebo údaje vydávané za kernelový peer.
Nejprve se ověří Root-owned code tree a chráněné soubory. Ed25519
podpisy, registry/frontier, boot/cluster/timeline a peer binding se
kontrolují před i po SQL 004.
Profily `registry-probe` a `ai-router-control` mají pevnou ověřenou TLS
CA/server name. Klientský i serverový timeout doplňuje 15sekundový
watchdog včetně cleanup; není SQL ani poskytovatelský fallback.

Permit kind je `ai-router-read-permit`, registrace
`ai-router-client-registration`. Čtyři přesné podepsané evidence kinds
jsou `ai-router-read-identity`, `ai-router-read-retention`,
`ai-router-read-cost`, `ai-router-read-schema`; vážou stejný request,
store, dataset/runtime/proof, policy/frontier a schválený cost policy.
Kontrola očekává COP potvrzený `cop-sim-ai-projection-v1` a
`cop-jizda-only-sim-preserved-v1`, nikoli nový rozsah globální identity.
Výstup `{admission,record}` obsahuje
`sim-ai-router-checkpoint-admission-v1` a inline podepsaný kind
`ai-router-read-admission`, korelovaný přes přesné bajty včetně newline.
Platnost je nejvýše pět sekund od pozorování i vydání a nikdy déle než
permit, evidence, registrace, frontier a skutečný runtime proof.

COP potvrdil čerstvý krátkodobý permit pro každé `inspect` a delivery v
chráněném tmpfs, bez nové trvalé per-read identity historie. To je kontrakt
dalšího skutečného zapojení, nikoli důkaz přijatého enrollmentu nebo
nasazeného produceru. Immutable execution origin a jeho známý/nejistý
commit mají oddělený životní cyklus: fresh read permit neopravňuje založit
nový origin místo původního. Maintenance lease pro změnu checkpointu je
rovněž výslovný a oddělený od chat/read oprávnění.

[Samostatný skutečný Linux test](../archive/2026-10-15_AI_ROOT_CHECKPOINT.md)
prošel 14/14 novými skupinami: skutečné SQL 001–005, Root podpisy/custody,
TLS a zkompilovaná BYOK key/chat cesta při vypnuté aktivaci mazání.
Prošlý nebo odvolaný důkaz vracel 503 před providerem a změnou dat.
Dvě provider odpovědi byly syntetické, žádné externí volání neproběhlo.
Fixture peer a metadata nejsou nativní enrollment a výsledek předchází
níže popsanému production composition loaderu. Starší případy se nepřičítají.

Reader při podpisu používá tentýž keyring snapshot jako při ověření
permit/evidence; signer musí patřit právě do něj. Před i po podpisu
se kontroluje neměnnost keyring/signer bytes. Změněná konfigurace se
odmítne, nezkouší se znovu s novým trust setem. To nenahrazuje skutečně
drženou Root config/generation lease při aktualizaci nebo obnově.

`apps/ai-router-api/src/owner-checkpoint.ts` nyní tvoří konkrétní zdrojový
adaptér. Pevně načítá pouze Root-owned ordinary code tree
`/opt/cop-account-safety/ai-root-inspect.mjs` a COP potvrzený export
`createProductionAiCheckpointAdmissionPort()`. Před importem kontroluje
i všechny závislosti, ne pouze vstupní soubor; nepřijímá cestu či factory
z env nebo HTTP. Pro každý checkpoint vyžádá nové `inspect`, předá pouze
přesný typovaný snapshot bez user/key/URL/permit selektoru a zkontroluje
shodu přijetí. Kryptografii a kernelový peer ověřuje skutečný COP nativní
klient, nikoli tento shape adaptér. Chybějící modul, port, neplatné přijetí
nebo výjimka skončí `false`, nikdy kladným fallbackem. `index.ts` jej
předává skutečnému `PgAccountErasure`; příznak vypnutého mazání tuto
kontrolu COP chatu neobchází. Třináct nových unit případů používá stub port
nebo filesystem a nedokládá produkční autoritu.

Před aktivací zůstávají společné gates: připnuté skutečné instalované bytes a enrollment,
aktuální nezávislá autorita, nativní peer/delivery, SQL 004/005 a podepsaný
readback, produkční BYOK key/chat/legacy parita včetně nákladů a výpadků, zachování
SIM/IZS identity a fyzická restore/replay akceptace. Produkce ani chat
nebyly tímto zdrojovým doplněním přepnuty.

## Stávající spojení COP a SIM

### Zdrojové production composition měření — 15. 10. 2026

`driver-owner-composition.ts` nyní pevně načítá čtyři COP moduly pod
`/opt/cop-account-safety`: `driver-root-channel.mjs`,
`driver-root-inspect.mjs`, `driver-root-context.mjs` a
`driver-root-retention.mjs`. Kontroluje Root custody celé obyčejné closure
před importem a přijme pouze pevné factories execution, read admission,
request scope a maintenance consumer. Chybějící kterýkoli modul, factory
nebo potřebná metoda vrací explicitní `guarded:{}`, nikdy legacy SQL.
Nejde o env přepínač nebo důkaz aktuální skutečné Root autority.

Skutečný SDA `index.ts` tuto kompozici předává do `createApp`. Middleware
po body parseru předává do lokálního ALS scope pouze přesný POST mazání
účtu nebo DELETE odvolání měření, se šesti poli method/path/auth/actor/
actorSignature/body. Dávky GPS, preflight, GET/read ani jiné endpointy se
do scope nepředávají. ALS není lease, podpis nebo drain. Odmítnutá lokální
scope validace pokračuje bez kontextu, aby skutečný handler zachoval
401/400; platná mutace bez chráněného kontextu vrací 503 před SQL.
Ani chyba po předání callbacku nevyvolá `next()` podruhé.

Standalone `driver-maintenance-cli.ts` používá
`createProductionDriverMaintenanceControl()` se stejným loaderem,
guarded porty a výslovným maintenance consumerem. Bez consumeru skončí
unbound před konfigurací/pool init; není vlastní cutoff, alternativní SQL
cesta ani CLI selektor. Init/run/close jsou skutečně awaitnuté a close
proběhne i při selhání. Faktories jsou zdrojové vstupy; jejich produkční
enrollment, immutable origin a nativní lifecycle se přijímají samostatně.

Před cutoverem byla nalezena další mezera: raw SQL čtení `aggregates` a
`quality` neprocházelo chráněnou publikační hranicí. **Guarded režim je
nyní odmítne 503 ještě před SQL**, dokud není přijata skutečně držená
generation/read/publication bariéra. Pětisekundový checkpoint admission
ji nenahrazuje. Původní režim před koordinovaným cutoverem se nemění.
OpenAPI fragment i závazný JSON výslovně dokumentují tuto nedostupnost.
Stávající odvozené soubory/cache musí navíc projít Root report inventory;
zavření endpointu samo nedokazuje odstranění dříve publikovaného souboru.

Nový interní adapter `driver-publication.ts` připravuje přesnou hranici
pro budoucí skutečný Root port:
`withLease({kind: "aggregates" | "quality"}, async lease => ...)` a
`lease.assertCurrent(): Promise<void>`. Žádné HTTP pole ani proměnná
prostředí port nevybírá. Wrapper drží callback přes skutečné SQL, poslední
ověření před JSON a skutečné `finish`/`close` odpovědi. Časový limit 15 s
od vstupu pouze zavře HTTP; není důkazem zrušení SQL ani quiescence.
Předčasné ukončení portu zablokuje pozdější publikování, ale wrapper dál
čeká na zahájenou práci. Před hlavičkami je chyba 503; po odeslání nebo
zavření se nedělá druhý zápis, pouze pevná neidentifikující výstraha.

Store v guarded režimu přijme interní lease interface a kontroluje jej
před a po skutečných dotazech. **Interface ani syntetický unit port nejsou
Root autoritou. Produkční loader jej dosud nepřipojuje**, takže guarded
reporty dál vracejí 503 před SQL i před dotazem na dataset. Připojení
vyžaduje přijatý Root sdílený publikační zámek, exkluzivní protějšek pro
všechny destruktivní writery a policy/restore přechody, nativní peer
continuity a skutečný release/drain test. Root nesmí HOLD uvolnit jen
podle TTL nebo chyby spojení. Existující report inventory zůstává zvlášť.

[Nové aplikační ověření](../archive/2026-10-15_DRIVER_OWNER_COMPOSITION.md)
má 611 PASS a 6 opt-in PostgreSQL SKIP, celkem 617. Zahrnuje 40 nových
composition, custody, CLI, HTTP ordering a publication-denial unit případů;
všechny nové porty/storage/filesystemy v těchto případech jsou syntetické.
Není to skutečný Root transport, podpis, produkční restore nebo activation.
Typecheck, build a OpenAPI validace prošly. Produkční služby nebyly změněny.

Čtecí kontrola na `docker.home.cz` dne 14. 10. 2026 potvrdila níže uvedené
kontejnery, port bindings, DNS aliasy a společné sítě. Neprováděla HTTP
dotazy s tokenem, změny sítě nebo zkoušku mazání. Obě spojovací sítě mají
`Internal=true`; jejich existence neprokazuje nativní oprávnění operace.

| Kontejner | Existující port a cesta z COP API | Existující síť |
| --- | --- | --- |
| `csm-sim-ai-router-api` | HTTP `4050/tcp`, alias `ai-router-api`, bez host port bindingu; `/api/v1/ai-router/...` | `cop_sim_ai_router_internal` a `sim_default` |
| `csm-sim-situation-data-api` | HTTP `4020/tcp`, alias `sim-driver-measurements`, bez host port bindingu; `/api/v1/internal/driver-measurements/v1/...` | `cop_sim_driver_measurements_internal` a `sim_default` |
| `cop-cop-api-1` | Existující API `4310/tcp` s host bindingem 4310 se nemění; COP je připojený k oběma výše uvedeným sítím | `cop_default` a obě spojovací sítě |

Pro interní společnou kontrolu jsou tedy současné adresy
`http://ai-router-api:4050` a
`http://sim-driver-measurements:4020/api/v1/internal/driver-measurements/v1`.
Nejde o nový listener. Privátní nativní socket, jeho cesta, peer binding
a jeho přijatý produkční kontrakt zatím určené nejsou; HTTP porty 4050/4020
nejsou Root authority ports. Veřejné nginx routování measurements zůstává
404 a bez access logu (`apps/simulator-web/nginx/default.conf:46`).

## Nejmenší zdrojová změna před budoucím wiring

Nejprve vytvořit samostatný consumer boundary modul bez transportu,
aplikačního importu a pozitivního verifieru. Návrh umístění je
`packages/account-safety-client/src/ports.ts` a
`packages/account-safety-client/src/bindings.ts`; nyní tyto soubory
nevznikají. Modul může popsat pouze typované porty a pevné vlastnictví
`sim_ai_router → ai_router / cop_router_primary_database` a
`sim_driver_measurements → sim_measurements / online_driver_scope`.
Dokud nejsou přijaty skutečné operation registrace, vrací každý chráněný
port unavailable a nesmí provést callback, DB změnu nebo provider dispatch.

Přijatý produkční request/response, operation schema, bootstrap a skutečný
transport jsou vstupy další revize, nikoli hodnoty odvozené z fixture V5.
V5 klient pod `scripts/lib` se do aplikace neimportuje. Budoucí in-process
native binding má vlastní source/toolchain/binární gate podle
[návrhu v integraci 22](22_COP_ACCOUNT_ERASURE_CONTRACT.md#návrh-nejmenšího-nativního-transportu-pro-node).

### Dokončený lokální životní cyklus retence

Driver store už v konstruktoru nezakládá retenční časovač. Nový
`driver-retention-lifecycle.ts` odděluje skutečný init, výslovné spuštění,
jednotlivý úklid a close. API composition odmítne start bez maintenance
consumeru ještě před retenčním init SQL; samostatný compiled
`driver-maintenance-cli.ts` má bez této vazby stejný výsledek, bez čtení
secrets či vytvoření DB poolu. Běžné ostatní API kvůli tomu nezanikne.

Typovaný callback s přesným ownerem a neměnným UTC cutoff není native
protokol nebo autorita. Skutečný consumer musí zvlášť prokázat přijatou
owner operaci, replay a oprávnění k práci. Bez něj produkční factory vrací
`DRIVER_RETENTION_UNBOUND`. Nová verze proto není způsobilá nahradit
dosavadní fyzický úklid, dokud tato závislost a retence neprojdou akceptací.

Oba dočasné DELETE používají jeden cutoff v jedné transakci. Permanentní
fence a erasure ledger zůstávají nedotčené. Lifecycle sleduje skutečnou
promise úklidu odděleně od promise consumeru, nepřekrývá práci a close na
ni vyčká. Z toho neplyne nativní drain, abort ani potvrzení fyzické obnovy.

### Pevný databázový původ expirace

Zdrojový kandidát
`scripts/fixtures/driver-retention-real-schema/expiry-source.sql` rozvíjí
konkrétní origin mechanismus COP nad nezměněným skutečným schématem SIM
`schema.sql` a migrací `002_account_erasure.sql`. Není v adresáři migrací,
nevytváří aplikační tabulky, nemění jejich vlastníka ani stávající guard a
neimportuje se do API. Samostatný test
`scripts/test-driver-expiry-real-schema.mts` používá pouze novou soukromou
lokální databázi se syntetickými daty.
Jeho [samostatný záznam](../archive/2026-10-14_DRIVER_EXPIRY_REAL_SCHEMA.md)
obsahuje jeden vlastní běh PostgreSQL 18.3 s 11/11 případy a přesné piny;
nejde o přepočet dřívějších lifecycle nebo autorských COP testů.

Jedinou operací je expirace celého COP namespace pod jedním neměnným cutoff.
Oddělený kontrolní kanál jednorázově váže origin na původní XID8, PID a
backend start; pevný executor toto spojení znovu ověří. Dva DELETE, oba FK
cascades a marker výsledku sdílejí původní transakci. Trvalé revokace,
erasure operace a checkpoint nejsou součástí destruktivního plánu. Origin
neuchovává contributor hash, manifest ani vazbu účtu na denní pseudonymy.

Resolver používá stejný zámek originu. Výsledek uvnitř control transakce
je pouze prozatímní: terminal vyžaduje skutečný control COMMIT a nové čtení
stejného originu. Ztracené potvrzení dovoluje pouze probe původního originu,
nikoli nový pokus o mazání. Chybějící origin či zaneprázdněný executor zůstává
pending. Trvalý seal uzavírá pouze povolené efekty tohoto přesného originu;
neprokazuje SQL rollback ani owner-wide drain.

Omezené `SECURITY DEFINER` funkce a role jsou zde pouze zdrojovým kandidátem
pro izolované ověření. Nejsou implicitním rozšířením původních aplikačních
migrací nebo schválením produkčního přístupu. Jejich budoucí instalace potřebuje
konkrétní přijatý Root runner, registry, scope a profile. Pět grant/inspect
metod není privátní executor a `recordOutcome` se za něj nepovažuje.

Univerzální whole-COP plán lze přijmout jen s doloženou retenční a report
politikou bez individuálních retain výjimek a se stabilní writer/protection
generací. Samotný origin lock tuto generaci nechrání. Při individuální výjimce
nebo chybějící bariéře zůstane tento plán vypnutý a musí vzniknout samostatná
připravená effect closure; nikoli tiché filtrování nebo nový app cutoff.

### Společná změna writerů a práv před nasazením

Odebrání přímého DELETE zůstává v tomto kroku pouze v izolované zkoušce.
Aktuální `revoke()` a `erase()` jej potřebují; změna samotných grantů by
znefunkčnila legitimní odstranění dat. Produkční přechod proto musí současně
zachovat všechny níže uvedené švy a upravit provisioning/recovery, které dnes
blanket DML granty znovu udělují a vyžadují.

| Cesta | Požadavek budoucího přechodu |
| --- | --- |
| Commit a lookup | Zachovat batch → contributor zámky, dočasnou revokaci, permanentní fence i receipt trigger uvnitř transakce. |
| Revoke | Stejný contributor zámek před upsert a receipt cascade; zachovat schválenou dobu dočasné revokace. |
| Erase a acknowledge | Operation zámek → setříděné contributor zámky; fence, cascade a ledger atomicky, původní actor/request/acceptedAt a oddělené replay/publikace. |
| Periodický a samostatný úklid | Stejný přijatý původní executor, žádný alternativní pool/SQL/cutoff z aplikace. |
| Granty a recovery skript | Zákaz přímého DELETE až s funkčními náhradami; UPDATE zúžit na skutečně používaný `receipt`, ne expiry/owner/contributor/key. |
| Restore quarantine | Privilegovaný TRUNCATE je zvláštní pre-start/replay operace, nikoli retenční oprávnění. |

Contributor executor z testovacího COP kandidáta se nepřebírá: nemá skutečný
SIM contributor lock a admission coupling a jeho origin journal vytváří
novou trvalou vazbu na contributor hash. Hash není anonymizace; taková vazba
by vyžadovala oddělené privacy, retenci a unlink rozhodnutí.

### Koordinovaný databázový patch driver operací

`deploy/driver-measurements/003_guarded_operations.sql` zavádí konkrétní
zdrojové owner routines pro expiraci, revokaci a erasure nad nezměněnými
aplikačními tabulkami. Funkce vyžadují oddělené předem zřízené control/exec
role a NOLOGIN ownera; soubor nevytváří přístupy ani se automaticky neaplikuje.
Produkční přijetí celého skutečného vykonavatele a jeho oprávnění zůstává
samostatným krokem, nikoli efektem této zdrojové změny.

Privátní DB rozhraní v `sim_driver_guard_source` tvoří `register_origin`,
`claim_origin`, `execute_origin`, `resolve_or_seal` a control-only
`read_publication_context`. Nejde o veřejné RPC
nebo o nový REST endpoint. Pevný origin přichází z Root registru; běžná
aplikace nevybírá SQL, spojení, PID, XID ani jiný cíl. Tělo jde pouze jako
transient JSONB. Jeho binding je SHA-256 UTF-8 PostgreSQL `jsonb::text`,
ne `JSON.stringify`. Root-owned control musí porovnat právě tento digest
se svým přijatým registrovaným tělem. Diagnostická funkce
`runtime_privileges_match` neuděluje oprávnění k operaci.

Kinds jsou `expire`, `revoke`, `erase`, `ack`; verze privátního těla je
`sim-driver-guarded-db-v1`. Revoke přijímá pouze contributor hash, drží
dosavadní contributor zámek a nesmí zkrátit existující tombstone. Erase
váže operation/actor/request hash a dočasný manifest na původní přijetí,
zamyká operaci a setříděné contributor keys a atomicky provede permanentní
fence, receipt cascade a ledger. Den a contributor hash se do originu
neukládají; nevzniká nový trvalý account/day join.

Sedm dní revokace se počítá od skutečného času po získání contributor
zámku, ne od začátku dlouho čekající transakce. Existující pozdější expiry
se nezkracuje. Gate metadata se čtou až po contributor zámcích a jejich
řádek zůstává share-locked až do původního COMMIT.

Control-only `read_publication_context(uuid,jsonb)` přijímá pouze již
commitnutý `erase` origin a přesné původní šestipolové tělo. Pod operation,
contributor a state/store zámky vrací sedm scalar polí:
`storeIncarnation`, `payloadDigest`, `erasureOperationDigest`,
`databaseZeroVerified`, `remainingBatchCount`, `exactFenceCount`, `readbackAt`.
Žádný manifest, účet nebo contributor identity se nevrací ani neukládá.
Ledger digest používá PostgreSQL `to_jsonb(ledger)::text` při UTC; readback
digest používá stejnou PG JSONB-text SHA-256 konvenci. Nejde o podpis.

Nový samostatně registrovaný `ack` origin může přidat přesně typovaný
`publicationContext` verze `cop-driver-publication-context-v1` s osmi poli
`contractVersion`, `recordId`, `recordDigest`, `storeIncarnation`,
`operationDigest`, `readbackDigest`, `reportProtection`, `observedAtUTC`.
Původní `payloadDigest` se počítá bez tohoto kontextu, takže nevzniká kruhový
hash. SQL porovná skutečný uzamčený ledger, zero, přesné fences, checkpoint,
store a report protection s přijatým kontextem. Čas je konečný, kanonický
UTC s milisekundami a nesmí být budoucí. Platnost skutečného záznamu a jeho
aktuálních referencí ověřuje Root; samotný SQL čas ani digest ji nedokazuje.

Samostatný `ack` kind, historické DB flags ani syntetický kontext nejsou
skutečný publikační důkaz. Root musí před registrací ACK nezávisle ověřit
podpis, čtyři aktuální evidence reference, původ manifestu a skutečnou
reportovací politiku/inventář. `no_report` nelze odvodit z prázdné odpovědi.
Bez kontextu ACK zůstává čekající a ledger nemění, ani nesníží dříve
potvrzený stav. Platný kontext umožní databázové potvrzení až v původní ACK
transakci; terminal dále vyžaduje skutečný COMMIT a čerstvý readback.
`wholeAccountComplete` zůstává false. Databázová transakce je výsledek
přesného originu, nikoli důkaz celého smazání nebo obnovy záloh.

Stejná změna zužuje runtime na čtení, intake INSERT a receipt-only UPDATE.
Přímé ledger/fence DML a destructive execute z běžného runtime nejsou
povoleny. Provisioning při nalezeném guarded namespace odmítne legacy
apply/recover; `--check` použije pouze pevný čtecí SQL verifier. Chybějící
role, funkce nebo execution vazba se v aplikaci musí mapovat na 503/pending,
nikoli na odvolaný souhlas nebo potvrzené smazání.

Verifier kontroluje i účinné sloupcové granty zděděné z PUBLIC, ne pouze
table-level ACL. Přechod odstraní původní table i column granty PUBLIC a
runtime, pak výslovně vrátí jen potřebný intake profil. Pevný čtecí verifier
má `search_path=pg_catalog` a nevolá těla funkcí dodaná databází.

Přesné známé chyby payload/manifestu mají SQLSTATE `22023`; actor-mismatch
a chybějící erasure operace `P0002`, neměnný request/body/origin konflikt
`23505`. Guard/metadata/context chyby mají `P0001`, chybějící oprávnění
`42501` a funkce `42883`. Aplikační adaptér smí mapovat jen konkrétní známé
chyby: validace 400, nepřístupná operace 404, idempotency konflikt 409,
ostatní unavailable 503. Obecné `23514` není odvolaný souhlas. Po nejasném
COMMIT se nejprve zjišťuje původní origin, bez opakování efektu a bez
předčasného 400/404/409.

Nové [izolované ověření 15. 10.](../archive/2026-10-15_DRIVER_GUARDED_OPERATIONS_SQL.md)
prošlo 18 vlastními PostgreSQL případy a samostatně pěti offline testy
provisioningu. Ověřuje SQL mechaniku, nikoli skutečný Root podpis,
delivery, restore, aplikační wiring nebo nasazení. Starší důkazy se
nepřepisují ani nepřičítají. Závazný REST kontrakt zůstává nezměněný.

### Přesná místa nativního zapojení

#### Interní driver execution port a opt-in zapojení

Konkrétní typy jsou v
`apps/situation-data-api/src/driver-guarded-execution-port.ts`.
Soubor obsahuje typové deklarace. Lokální adaptace a ověření přesné
struktury jsou v `driver-guarded-execution.ts`; skutečná Root runtime
factory, transport a registrace nejsou součástí SIM implementace.
`DriverGuardedExecutionPort` má dvě metody:

```ts
execute(request: DriverGuardedExecutionRequest): Promise<DriverGuardedExecutionResult>;
probe(operation: DriverGuardedOperationRef): Promise<DriverGuardedExecutionResult>;
```

Request spojuje Root-delivered `{operationId, kind}` s přesně typovaným
transient tělem odpovídajícího kind. Obsahuje jen již definovaná privátní
SQL těla. Typ není důkazem přijetí: skutečný adaptér musí ověřit podpisy,
pevný owner/store, registrovaný body/schema digest, aktuální frontier a
vazbu ke konkrétnímu autentizovanému požadavku. Reference nesmí přijít z
nového HTTP pole/hlavičky, vzniknout náhodným UUID v aplikaci ani být zvolena
podle samotného neprůhledného ID klienta. Cesta tohoto skutečného delivery
a jeho enrollment jsou vstup navazujícího wiring; nejsou implementované
typovou deklarací.

Výsledek rozlišuje `pending`, `origin-commit-known` a
`origin-no-effects-closed`. Terminal musí nést ověřené `sqlOutcomeRef` a
`effectQuiescenceRef` ze stejného Root originu a aktuálního přijatého
bindingu. Vnitřní SQL JSON, timeout nebo odpověď procesu bez těchto ověření
nesmí vytvořit terminal. Wire pending nyní nemusí obsahovat operation ID;
adaptér zachová jeho místní korelaci z původního požadavku, ale nevydává ji
za podepsaný Root údaj.

Root `operation.operationId` je UUID původního execution originu, nikoli
veřejné `DriverErasureInput.operationId` ani jeho HMAC `operationHash`.
ERASE a ACK mají různé Root origin UUID, ale stejné base business vazby.
Adaptér musí toto rozlišení zachovat při korelaci i po restartu.

Po ztracené odpovědi nebo restartu pokračuje pouze `probe` stejného originu.
Nový UUID, permit, cutoff nebo nový DELETE nejsou opravou ztraceného
potvrzení. `origin-no-effects-closed` uzavírá efekt přesného originu;
neprokazuje SQL rollback, owner-wide drain ani úspěšné smazání účtu.
`probe` navíc není čtecí metoda: SQL `resolve_or_seal` může trvale uzavřít
neprovedený origin. Smí jej vyvolat jen chráněný resolution tok původní
operace, nikdy dosavadní read-only HTTP GET/status nebo preflight.

Přítomnost interní constructor volby `guarded` zapíná pouze tuto zdrojovou
větev; i prázdná nebo null hodnota ji ponechá nedostupnou, nikdy nevybere
legacy SQL. Bez této volby zůstává původní režim před koordinovaným
přechodem. Není přidaný environment přepínač. Pevný zdrojový production
loader výše nyní dodává pouze skutečné COP porty, nebo explicitně unbound
guarded režim; není to přijaté produkční spojení.
Volba guarded režimu se zachytí při konstrukci a pozdější změna caller
options ji nesmí přepnout zpět na aplikační DML.

| Místo ve zdroji | Implementace guarded větve |
| --- | --- |
| `driver-measurement-store.ts` — `cleanup` | Deleguje oba DELETE i původní transakci na expire port s tělem `{contractVersion}`. Aplikační pool neprovádí DML. Cutoff je neměnný z registrovaného originu, ne nový app clock. |
| `driver-measurement-store.ts` — `revoke` | Deleguje upsert, DELETE a transakci na revoke port se stávajícím serverovým contributor HMAC. Lock/upsert/cascade/marker vlastní SQL 003 a původní Root transakce. |
| `driver-account-erasure-store.ts` — `erase` | Deleguje celou mutaci fences/cascade/ledger na erase port. Zachovává serverovou přípravu operation/actor/request hash a manifestu; Root dodává registrovanou operaci a checkpoint binding. |
| `driver-account-erasure-store.ts` — `acknowledge` | Místo aplikačního UPDATE vyžaduje samostatný ACK origin a Root publication context. DB flag ani `no_report` příznak jej nevytváří. |
| `driver-measurements.ts` — composition a account POST | Předává guarded volby přímo do skutečných store konstruktorů a kontext jen interním argumentem. Kombinace guarded voleb s předkonstruovaným store je odmítnutá. ACK nevzniká z `no_report` nebo void callbacku. HTTP actor, auth, parser, limity a 200/202 kontrakt zůstávají. |
| `driver-retention-lifecycle.ts` | Přijímá volitelnou přesnou expire origin reference v interním kontextu; lokální consumer/časovač řídí pouze životní cyklus. Guarded cleanup bez reference selže. `close()` čeká na skutečné lokální promises, bez tvrzení native drain. |
| `index.ts`, `app.ts`, `driver-maintenance-cli.ts` | Používají pevný owner loader a stejné guarded/maintenance závislosti. Při chybě zůstává explicitně unbound guarded větev; žádný legacy fallback, alternativní SQL pool nebo CLI selector nevzniká. |

Driver metody dostávají operation reference pouze interním per-call
argumentem. `DriverGuardedRequestContextPort.current(kind)` je předávací
hranice právě autentizovaného volání, nikoli registrátor nebo lookup podle
HTTP pole. Jeho skutečný konektor musí dodat Root transport. Běžné `lookup`/`commit` zůstávají na
omezeném runtime poolu se stejným batch → contributor pořadím, receipt
triggerem a temporary/permanent fence. Zúžení grantů musí proběhnout až
společně s funkčními náhradami všech čtyř cest.

Maintenance context a jeho strict validátor `operation()` zachovávají
`owner` a `cutoff` a nově ověřují volitelný přesný expire origin se dvěma
poli `operationId`, `kind`. Vnořená metadata se kopírují a zmrazí. Adaptér
nesmí hledat origin globálně podle času, doplňovat nový cutoff nebo vydávat
zmrazený JavaScript objekt za oprávnění.

Samotný execution port nenahrazuje chráněnou čtecí/admission hranici.
Guarded `PostgresDriverAccountErasureStore.gate` kontroluje úzký read/intake
profil bez ledger DML práv a nepoužívá legacy zero-argument proof.
`DriverGuardedReadAdmissionPort.inspect` vyžaduje pevný owner/scope a účel
`capability`, `intake`, `preflight`, `status` nebo `receipt`; kde patří,
váže actor i operation hash. Přesný checkpoint/report protection a Root
reference musejí odpovídat databázi i skutečnému aktuálnímu Root ověření.
Lokální kontrola tvaru/reference není ověření podpisu nebo frontier.
Bez přijatého admission portu je capability not ready a guarded intake i
mutace jsou nedostupné, i při prázdném ledgeru. Není dovolena funkce
vracející kladné booleany. Starý gate zůstává jen v původní neguarded větvi.

Po `origin-commit-known` může erase/ACK provést nový read-only actor-bound
ledger readback a vytvořit stávající `DriverErasureReceipt` jen pod platnou
chráněnou čtecí hranicí. Erase marker sám neznamená `completed`; do ACK
zůstává HTTP 202. `wholeAccountComplete=false` se nemění.
HTTP receipt přebírá kumulativní ledger `deleted_batch_count` a první
`created_at`; nepoužije per-invocation SQL počet, který je při opakování
legitimně nula, ani nový čas aplikačního pokusu.

Revoke potřebuje původní počet smazaných dávek pro stávající HTTP odpověď.
Proto má commit výsledek volitelné `revokeEffect.deletedBatchCount`.
Root jej smí vydat jen z původního pozorovaného scalar receipt svázaného
s origin/body digestem a až po potvrzeném commit. Scalar se musí zapsat a
fsyncnout před pokusem o původní COMMIT, aby šel po restartu ověřit; při
no-effects nebo pending se nevydává. Chybějící/poškozený receipt při známém
commit znamená v SIM 503, ne vymyšlenou nulu nebo nové mazání. Jde o
samostatné Root custody rozšíření, nikoli změnu frozen SQL journalu 003.

Pro revoke `pending`, no-effects nebo chybějící count znamenají 503
`DRIVER_MEASUREMENTS_UNAVAILABLE`. Mutující erase/ACK při chybějícím
kontextu, pending, no-effects nebo neověřitelném readbacku vracejí 503
`DRIVER_ACCOUNT_ERASURE_UNAVAILABLE`, ani starý completed ledger chybu
nezamaskuje. Po známém erase commit může stávající receipt zůstat 202,
dokud Root nedoručí ACK; read-only GET může vrátit dříve přijatou pending
operaci bez spuštění resolution. Retenční cleanup uspěje pouze při
ověřeném commit, jinak `DRIVER_RETENTION_UNAVAILABLE` a evidence téhož
neuzavřeného originu u chráněného vlastníka. Žádný obecný SQLSTATE, návrat
procesu nebo no-effects stav se nemapuje na potvrzené odvolání souhlasu.

Vypnutý erasure flag zakazuje nové operace, nikoli dokončení již přijaté.
Guarded resume před dispatch vyžaduje existující durable ledger se stejným
actor i request hashem a všechny aktuální admission/gate kontroly.
Chybějící nebo jinak vázaná operace zůstane 503 bez dispatch. Pouhé
vypnutí příjmu měření ani mazání nesmaže stávající trvalé fences.

Runner si v paměti drží pouze místní fingerprint nejasného pokusu pro
korelaci opakování, nikoli PG/Root body digest. Překrývající se pokusy
stejného originu sloučí, změněné tělo odmítne a neurčitý výsledek opakuje
jen přes probe. Má limit 128 neuzavřených lokálních originů; další odmítne
bez vygenerování náhrady. Durable recovery po restartu vlastní Root,
nikoli tato lokální mapa. Přesné tělo se znovu validuje po JSON snapshotu.

Zdrojové opt-in zapojení ještě není aktivní produkční spojení. Před
nasazením jsou nutné společné testy skutečného delivery, signed výsledků a chráněných readbacků,
zejména ztraceného COMMIT potvrzení, scalar receipt recovery a souběhu s
příjmem. Veřejný OpenAPI a `sim-driver-measurements-v1` se nemění.
Lokální syntetické testy portů a aplikačního toku mají samostatný
[záznam](../archive/2026-10-15_DRIVER_GUARDED_APPLICATION.md). Nejsou důkazem
skutečného Root delivery nebo restore; dřívější SQL důkaz zůstává beze změny.

#### Ostatní aplikační hranice před zapojením autority

| Soubor a současný port | Konkrétní potřebná změna po přijetí autority |
| --- | --- |
| Router `src/index.ts:17`, `PgAccountErasure` | Composition root předá skutečný consumer; nynější výchozí `OwnerCheckpointVerifier` je false. Před chráněnými COP pracovníky ověří enrollment/replay, nikoli pouze DB schema. |
| Router `src/account-erasure.ts:12,64` | `assertActive(target, transaction?)` a boolean checkpoint verifier rozšířit o accepted operation/reference, current frontier a held commit/read/drain výsledky. Jednoduché `true` není authority bridge. |
| Router `src/separate-routes.ts:49` | Key GET/PUT/DELETE: chránit čtení i vrácení výsledku; externí validaci `/models` v PUT vést jako samostatný original side effect, nejen key SQL. |
| Router `src/separate-routes.ts:94`, `src/app.ts:255` | BYOK chat i legacy COP generate: rozlišit rezervaci, provider dispatch/outcome a vrácení výstupu. COP fence nesmí zablokovat záznam původního pozdního nákladu, ale zabrání novému dispatch a publikaci. |
| Router `src/budget.ts:117`, `src/separate-billing.ts:53,110` | Native commit gate musí zachovat existing per-target fence ve stejné SQL transakci; key audit, reservation a finanční locky se nerozdělí. |
| Router `src/budget.ts:178`, `src/separate-billing.ts:152` | Settlement vychází z původní trvalé rezervace a její lane, ne z nového caller principalu. `uncertain` zůstává pending i po restartu. |
| Router `src/account-erasure.ts:161,188,245` | Fence/request, cleanup, zero readback a rollup expiry potřebují vlastní přijaté scopes; `processPending` není úplný replay. Worker 15 s ani startup policy DML nevytvářejí grant. |
| SDA `src/app.ts:113,116` | Předat skutečné přijaté závislosti do `registerDriverMeasurementRoutes`; protected proof, derived barrier a maintenance consumer zůstávají nezapojené. Zachovat measurement tracing exception. |
| SDA `src/driver-measurements.ts:213` | Actor-bound batch lookup, matcher, commit a response dostanou operation context bez raw GPS v native envelope. Neměnit `sim-driver-measurements-v1` ani `shadow_only`. |
| SDA `src/driver-measurement-store.ts:31,67,147` | Lookup, commit a revoke zachovají batch/contributor zámky, permanent fence a příslušnou native hranici až k původnímu commit výsledku. |
| SDA `src/driver-account-erasure-store.ts:6,13,89,113` | Nahradit nedostatečný zero-argument proof konkrétním operation/owner bound portem; erase a ACK mají zvlášť doložený drain, zero a publication/restore výsledek. |
| SDA `src/driver-measurement-store.ts:108,127`, route `aggregates/quality` | Owner-wide snapshot a response generation, nikoli vymyšlený osobní principal. Současná quality jsou tři on-demand dotazy, ne jeden společný transakční snapshot. |
| SDA `src/driver-retention-lifecycle.ts`, store `src/driver-measurement-store.ts:45,56`, `src/driver-maintenance-cli.ts` | Připojit skutečný přijatý maintenance scope a immutable cutoff k dokončenému lokálnímu životnímu cyklu. DB metadata ani UTC tvar nejsou native operation body. Erasure ledger/fences se nečistí se sedmidenními měřeními. |
| `apps/*/Dockerfile`, `docker-compose.yml` a opt-in overlay | Teprve samostatný schválený balíček může přidat připnutý native consumer/ABI a pevnou runtime vazbu. Žádný nový host port, Root klíč, Docker socket nebo široká DB role. |

V tabulce Router `src` znamená `apps/ai-router-api/src`, SDA `src`
znamená `apps/situation-data-api/src`. Všechny řádky vymezují budoucí nativní změny,
nikoli již připojená autorita. Přesné současné piny souborů jsou v manifestu.

SDA composition musí skutečně vytvořit scoped store a matcher. Pokud předá hotový store,
route factory jej nepřestaví pomocí dodaného proof callbacku. Native port
proto musí dostat přímo konstrukce `PostgresDriverMeasurementStore` /
`PostgresDriverAccountErasureStore`, ne pouze závislost routes. Výslovný
start retence už čeká na init a lokální consumer seam; přijetí skutečného
maintenance scope a aktuální replay je další nativní gate. Nestačí přidat
boolean callback do `index.ts`.

## Operace a jejich těla a schémata

Manifest obsahuje každou existující OpenAPI operation ID, metodu, cestu a
request schema ref pro key/chat/generate, čtyři measurement cesty a obě
erasure kolekce. Prefix `/situation-data` patří composite OpenAPI;
interní SDA listener jej nepoužívá. Contracty, service auth a ID uživatele
se kvůli přepnutí modelu ani native bindingu nemění.

| Existující operace | Současné tělo a digest | Co není nativní oprávnění |
| --- | --- | --- |
| Router BYOK key PUT | `AiRouterSeparateUserKeyPutRequest`, pouze `apiKey`; key GET/DELETE bez body | Klíč ani jeho fingerprint nepatří do native packetu. Actor `aud=sim-ai-router` není erasure actor ani přijatá Root identity. |
| Router BYOK chat | `AiRouterSeparateCopByokChatRequest`, `cop-chat-byok-v1`; published context má vlastní ověření | Prompt, private communication ani volný kontext nejsou owner evidence. Body se neposílá do native fixture DTO. |
| Legacy generate COP | `AiRouterAiRouterGenerateRequest`; typed `cop-chat-context-v1`, vlastní klasifikace a souhlasy | Body `userId` není runtime enrollment; SIM musí zachovat dosavadní identity a privacy/model policy. |
| Router erasure | Normalizované JSON v pořadí `{contractVersion,operationId}`; SHA-256; `AccountErasureRouterErasureRequest` | Ledger `body_digest` není Root frame, registered requestDigest nebo operation-schema digest. |
| Measurement batch | `parseDriverBatch`, potom HMAC `request:${JSON.stringify(batch)}`; `DriverMeasurementsBatch` | Float GPS payload ani batch HMAC se neadoptují do V5 či Root operation body. Raw GPS se neukládají ani nelogují. |
| Measurement revoke | `{contractVersion,contributorIdDay}`, `DriverMeasurementsRevoke`; server odvodí daily contributor hash | Pseudonym neprokazuje účet ani úplný manifest; absence account/day join se zachová. |
| Driver erasure | `parseDriverErasureRequest` setřídí manifest; HMAC účelu `cop:account-erasure-request` v `prepareDriverErasureInput`; `AccountErasureDriverErasureRequest` | Actor i request hash a manifest nejsou bootstrap. Všechny retained/outbox dny a verze klíče musí doložit COP bez trvalého account→days joinu v SIM. |
| Owner read/publication/maintenance | Aggregates dataset/since/now, quality, expiry a pending workers mají konkrétní source seams výše | Potřebují vlastní owner generation a cutoff, ne smyšlené userId nebo náhodný UUID vydaný za accepted operation. |

Jsou zde tři různé vrstvy digestů: existující HTTP idempotence/erasure body;
Router DB checkpoint `operation_digest/schema_digest` z ledgeru a SQL
functions/triggers/RLS (`account-erasure.ts:75`); budoucí nativní registrované
body/schema/opaque lease digests. Žádné z nich nelze prohlásit za jiné.
Manifest proto ponechá `nativeOperationCode`, `nativeBodyCanonicalization`,
`nativeOperationSchemaDigest` a accepted registration jako null. Nejde o
placeholder připravený k odeslání: bez těchto přijatých hodnot je wiring STOP.

## Zachované transakce a rozsah účtu

Router lock `pg_advisory_xact_lock(634020,hashtext(target))` zůstává u key
write/remove, COP reservation i erasure v jedné transakci. Invoker trigger
`ai_router_cop_erasure_fence` a scoped delete RLS z migrace 003 se nesmějí
obejít. Převod minimalizovaných lane/day finančních součtů, scoped delete
a potvrzení zůstávají atomické; finanční stropy se po smazání neresetují.

Driver commit/revoke/erase zamykají stejné contributor keys. Invoker receipt
trigger z migrace 002 odmítá nový či upravený receipt pro permanentně
odvolaného přispěvatele; intervals/ETA se odstraní FK cascade ze smazaného
receipt. Přidání nativní brány nesmí přesunout
kontrolu mimo SQL transakci nebo povolit nový příspěvek po drain/erase.

`finish` může zaznamenat doložený původní výsledek po fence; timeout nebo
smrt procesu nejsou known abort. Přijatý immutable permit nelze zpětně
anulovat nově vymyšleným požadavkem na nepřerušenou živost stejného procesu.
Owner-wide publikace a nový dispatch mají své oddělené generace a scopes.
Zdrojová větev nemá report publisher; z toho nelze odvodit actual `no_report`.

COP zachová vlastní same-transaction lifecycle fence a durable frontu.
SIM zachová `client_id=sim`, `sim_project`, IZS, shared Keycloak účet,
relace a oprávnění mimo COP/Jízda erasure scope. Nedostupný COP native
consumer nesmí vyvolat plošné odhlášení nebo přepnutí independent SIM/IZS.

## Neaktivní balíček a další rozhodnutí

Instalační inventář uvádí přesné existující source piny, navržené budoucí
souborové změny a nulové install/start/migrate/activate actions. Zatím není
schválená cílová cesta, owner/mode, finální archive hash nebo binární ABI;
`inactiveInstallAuthorized=false` a `installAllowed=false` zabrání záměně
za provozní balíček. Jednotlivá instalace neaktivních souborů může později
mít vlastní přesný souhlas před úplnou runtime akceptací; nemusí předstírat
hotový producer. Aktivace vyžaduje zvlášť skutečné B2/B3 důkazy.

Správce 14. 10. v 13:44 Praha doložil úzkou invocation/public-package
inventuru Patroni. SIM ověřil obsah a hashe receipts d6a0834d… / 7bf2ff93…;
nejde o druhý host běh, loaded-byte attestation nebo uzavření celé A1/A2.
Přesný DCS config CAS, effective auth, nezávislý anchor, skutečné owner
bootstrap/restore a app společná akceptace zůstávají konkrétními gates.
Historické V5/SQL/HTTP testy ani empty metadata DB je nenahrazují.

Navazující jediné čtení konkrétního DCS klíče v 14:24 Praha rozlišilo
revizi klíče od globální revize etcd. SIM ověřil oba receipts
fa09f658… / e4fb8a30…; neprovedl druhý host běh. Snapshot není budoucí
CAS souhlas, přijetí skutečného ownera, effective auth ani restore.
Před případnou pozdější schválenou změnou se přesná revize musí znovu
číst a porovnat.

U čistého infrastrukturního modelu deployment/rollback byla navíc
vymezena nepokrytá vazba: samotné UUID čekající operace neprokazuje
neměnný cílový release, obraz, zdroj a registrované tělo. Qualification
c63fd41c… ponechává původní model a jeho 16 testů zmrazené. Budoucí
nativní patch musí tuto vazbu držet i přes recover/rollback a otestovat
odmítnutí přesměrování čekající operace na jiný schválený obraz. Nejde o
prokázaný produkční obchvat; actual permission modelu stále odmítá.

Následující balíček tedy řeší accepted operation registrations a boundary
porty v uvedených souborech; nikoli další obecný fixture protokol. Bez
produkční instalace, nových oprávnění, klíčů, mounts, bootstrapu nebo
pozitivního verifieru. Migrace 002/003 jsou pouze současné source reference,
v tomto kroku se nespouštějí. Návrat neaktivních souborů odstraní jen tento
samostatný balíček; po skutečné aktivaci platí přísnější
[runbook 19](../runbooks/19_COP_ACCOUNT_ERASURE_PRODUCTION.md#návrat-a-incident).

## První ERASE a kontrola jeho výsledku

Guarded store před ERASE požaduje actor-bound `preflight`: před prvním
zápisem ještě nemusí existovat řádek operace. ACK naopak již před dispatch
vyžaduje `receipt`. Po potvrzeném ERASE i ACK se vždy znovu vyžaduje
`receipt` stejné operace, účastníka, request hashe a nezměněného checkpointu.
Potvrzený origin bez čitelného výsledku není úspěšné smazání.

Vypnutý příznak nepovoluje nový ERASE. Obnovit lze pouze skutečně existující
operaci se stejnou actor/request vazbou a aktuální autoritou. Chyba kontrol
zůstává 503 bez legacy proofu, náhradního dispatch či automatického probe.
[Regrese 25 testů](../archive/2026-10-15_FIRST_ERASE_PREFLIGHT.md) používá
skutečný čistý matcher nad syntetickými porty; není Root ani produkční akceptací.

Navazující držení jedné mutation autority přes preflight, ERASE, receipt,
publikaci a ACK se implementuje samostatně s COP. Běžné čtení nesmí získat
výjimku pro globální `pending` stav. Nový privátní scope nesmí změnit původní
origin, tělo, checkpoint ani deadline; HTTP finish/close nenahrazuje skutečný
SQL a native drain. Dokud není tento řetězec doložen společným testem, tato
oprava store sama o sobě neopravňuje zapnout produkční mazání.

## Privátní v2 vazba jednotlivého požadavku

Stav k 15. 10. 2026: aplikační validace, předávání níže a úzce omezený
Root scoped admission signer jsou ve zdroji. Jeho implementaci a izolované
testy uživatel výslovně schválil; souhlas nemění produkční oprávnění ani
nezapíná mazání. Nový signer prošel samostatným izolovaným důkazem 9/9
níže. Root keeper a úplný nativní v2 řetězec ještě nejsou společně
akceptované nebo aktivované. Kladný návrat testového portu tento řetězec
nenahrazuje. Veřejné HTTP/OpenAPI se nemění.

`mutationScopeRef` je přesně `{recordId,digest}`: UUID a SHA-256, bez dalších
klíčů, getterů či proxy. Dodává jej pouze chráněný interní port. Nejde o
veřejný business operation ID ani oprávnění odvozené ze samotného UUID.

| Aplikační hranice | Přesný privátní tvar |
| --- | --- |
| Kontext mutace | `{operation,mutationScopeRef?,publicationContext?}`; publikace jen pro ACK, scope nikdy pro `expire` |
| Execute | `{operation,body,mutationScopeRef?}`; původní operation a tělo se nemění |
| Probe | `probe(operation,mutationScopeRef?)`; nový scope po pending nepovolí nové execute |
| Čtení | `inspect(request,expectedMutationScopeRef?)`; scope pouze pro actor-bound preflight/status/receipt |
| Scoped admission | `contractVersion=sim-driver-mutation-read-admission-v2`, přesně request pole owner/scope/purpose/operationHash/actorHash a checkpointHash/reportProtection/mutationScopeRef/reference |

Pokud store očekává scope, přijme jen v2 se stejnou referencí, nikoli v1.
Bez očekávaného scope naopak nepřijme v2 ani v1 s přidaným scope. Běžné
capability/intake zůstává oddělené a nesmí dostat actor/operation pole.
Kryptografickou a skutečnou aktuální autoritu musí stále ověřit chráněný
port; aplikační porovnání tvaru/reference ji nevytváří.

Store vlastní neměnný snapshot kontextu již před prvním await a použije jej
pro obě kontroly i execute. Aktivní lokální volání stejného originu nelze
sloučit s jiným scope. Po pending lze s novým scope pouze probe téhož
originu a stejného těla. Tato místní ochrana neprokazuje SQL abort, Root
drain nebo správné chování nativního brokeru.

HTTP scope wrapper má povinné `run(scope,work,settled:AbortSignal)`. Middleware
naváže jednorázové finish/close posluchače před předáním handleru; první
událost synchronně zruší signál a odstraní oba posluchače. Zrušení zakazuje
nové výměny, ale nepotvrzuje dokončení již běžící SQL ani nativní práce.
Není zde časovač uvolňující autoritu. Skutečný Root drain a ukončení lease
musí samostatně doložit vlastník nativního spojení.

Common `readDriverMutationFacts(ctx,input)` vrací pouze nutná fakta. Vyžaduje
skutečný WeakMap Driver kontext pro mutation, živý podepsaný erase intent,
stejný peer/binding/hash/checkpoint a jednu serializovanou kontrolu před i
po pevném read-only SQL004 s potvrzeným COMMIT a END. Neotevírá další
metadata lease, nezavírá vypůjčený kontext a nevydává běžný read permit.
Přesné vstupní klíče jsou intentRef, purpose, operationHash, actorHash,
requestHash a checkpointHash.

### Omezený podpis kontrolního výsledku

Privátní `inspectDriverMutationAdmission(ctx,input)` přidává k uvedeným šesti
klíčům pouze `mutationScopeRef`. Účel je výhradně preflight/status/receipt.
Vstup neobsahuje callback, SQL klienta, cestu, vlastní facts, výběr ownera
ani veřejné user ID. Autentický kontext vybírá pevný Driver owner, profil,
SQL, nezávislou politiku a její piny.

Pevný soubor `/run/cop-account-safety/private/mutation-scopes/<recordId>.json`
musí být aktuální podepsaný `driver-mutation-scope` v Root-only adresáři
0700 na tmpfs. Podpis obsahuje přesně Root envelope a pole:

```text
scopeId requestDigest peer owner scope actionKind intentRef authorityRef
guardStoreId continuityEpoch datasetBindingId runtimeBindingId sourceProofId
storeIncarnation frontierSequence frontierDigest
```

`scopeId` je samostatné UUID korelace, nikoli origin nebo oprávnění.
`requestDigest` zde odpovídá celému původnímu HTTP scope a musí být shodný
s podepsaným intent `scopeDigest`. `authorityRef` musí odkazovat na právě
držený skutečný kontext; peer, owner, store, source a frontier se také
porovnají přesně. Scope nesmí přežít původní intent ani kontext.

Výsledek má přesně `{admission,record}`. Admission používá výše uvedený
typovaný v2 tvar. `record` je inline podepsaný Root záznam druhu
`driver-mutation-read-admission`; kromě Root envelope obsahuje přesně:

```text
request requestDigest guardStoreId continuityEpoch datasetBindingId
runtimeBindingId sourceProofId policyGeneration frontierSequence
frontierDigest storeIncarnation checkpointHash reportProtection
schemaFingerprint privilegeFingerprint factsDigest operationDigest peer
clientRegistrationRef authorityRef mutationScopeRef intentRef requestHash
```

Tento `requestDigest` je na rozdíl od scope digestu hash přesného Driver read
requestu. `operationDigest` může být null u chybějící operace pro preflight
nebo status; receipt vyžaduje skutečný actor-bound ledger. `requestHash`
musí odpovídat původnímu intentu a případnému ledgeru.

Signer sám provede skutečné read-only SQL a ověří jeho známé COMMIT/END;
nepřebírá kladná fakta od volajícího. Celá kontrola používá jedinou serial
operaci a stejnou metadata lease. Výsledná expirace nepřekročí žádný
z původních limitů kontextu, intentu, scope, target proofu, stáří facts
ani pětisekundového podpisu. Rozhodují skutečné podepsané časy ověřené
po podpisu a znovu před návratem, nikoli samotný vypočtený TTL.

Podpis nevytváří durable permit, neobnovuje kontext a nepotvrzuje inventář
reportů. Běžné `issueOwnerEphemeralRecord` zůstává omezené na ordinary
read/checkpoint-read. Chybějící keeper, transport nebo vazba původního
originu se nesmí nahradit tímto signed readbackem.

U v1 intentu zůstává výslovný limit: čas preflightu před prvním zápisem není
pozdější skutečný ledger `created_at`. Jejich nesoulad se odmítá bez časové
tolerance. Trvalá podepsaná vazba na původní origin a skutečný čas ledgeru
je další samostatná implementace, ne vlastnost tohoto facts helperu.

Samostatný [nový izolovaný důkaz 8/8](../archive/2026-10-15_DRIVER_MUTATION_SCOPE_BOUNDARY.md)
ověřil facts-only helper nad skutečnými podpisy, cílovým SQL a drženou
metadata session. Nevydal scoped admission a netestoval nový Root keeper,
packet transport ani celý řetězec prvního smazání. Dřívější důkazy zůstávají
připnuté ke svým původním zdrojům a nesčítají se s tímto během.

Navazující [samostatný scoped signer důkaz 9/9](../archive/2026-10-15_DRIVER_MUTATION_ADMISSION.md)
ověřil skutečný nový podpis, všechny uvedené vazby, expirace, běžné čtení
blokované při pending i HOLD při ztrátě cílového spojení. Intent/scope jsou
syntetické; keeper, nativní transport a pozitivní první ERASE zůstávají
neověřené. Common neexportuje `assertDriverMutationIntent` a nevytváří
durable A/B anchor; chybějící vazba musí odmítnout, ne použít náhradní port.
