# Příprava napojení ochrany účtu do SIM

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

## Stávající spojení COP a SIM

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

### Přesná místa budoucího nativního zapojení

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
