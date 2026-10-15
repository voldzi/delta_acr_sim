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

### Přesná místa budoucího nativního zapojení

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
přechodem. Není přidaný environment přepínač ani produkční factory.
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
| `app.ts`, `driver-maintenance-cli.ts` | Umožňují výslovné interní předání stejných přijatých závislostí/control; výchozí produkční factory zůstává unbound. Žádný alternativní SQL pool nebo nový CLI selector nevzniká. |

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
