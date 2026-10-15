# Nasazení mazání COP/Jízdy při zachování SIM

## Aktuální koordinovaný cutover Driver 003–005 a AI Routeru — 15. 10. 2026

Cutover zatím provedený není. Tento oddíl řídí schválené dokončení a
nasazení Driver SQL 003–005, AI SQL 004/005, skutečných Root readerů a
aplikačního zapojení. Opt-in Driver stores navazují na `0f56fc0`;
nová AI composition se přijímá spolu s odpovídajícím Root klientem,
nikoli jako samostatný image nebo databázový update. Obecný souhlas s
nasazením nechybí; otevřené jsou konkrétní podmínky níže.
Podrobné kontrakty jsou v [integraci 23](../integration/23_SIM_ACCOUNT_SAFETY_RUNTIME_PREPARATION.md#chráněné-čtení-skutečného-stavu-měření).
Tento postup nemění ani neoznačuje za aktuální starý neaktivní instalační
manifest. Původní minimální migrační postup níže sám neopravňuje k novým
privátním 004/005 instalacím. Historické source/fixture výsledky nejsou aktivace.

### Dokončený zdroj a dosud otevřená provozní hranice

- [Driver005 8/8](../archive/2026-10-15_DRIVER_ROOT_CHECKPOINT_SQL.md)
  ověřilo nový metadata setter v soukromém Unix-only PostgreSQL 18.3:
  úzká práva, přesný kontrakt, CAS, karanténu, expiraci, zámek, souběh
  a neměnnost ostatních dat. Není to Root enrollment nebo nasazení.
- [AI Root 14/14](../archive/2026-10-15_AI_ROOT_CHECKPOINT.md)
  ověřilo skutečné SQL 001–005, podpisy/custody/TLS a zkompilovanou
  Router BYOK cestu nad syntetickými peer/registry a dvěma syntetickými
  provider odpověďmi. Neproběhlo externí OpenAI volání ani skutečné účtování.
- `apps/ai-router-api/src/owner-checkpoint.ts` a `index.ts` nyní obsahují
  skutečný produkční composition vstup: pevný modul
  `/opt/cop-account-safety/ai-root-inspect.mjs` a COP potvrzenou factory
  `createProductionAiCheckpointAdmissionPort()`. Před importem se ověří
  Root custody předků, obyčejného entrypointu i celého dependency closure;
  žádné app/env zvolené cesty, symlinky nebo zapisovatelné helpers.
  Každý checkpoint vyvolá nový `inspect` bez cache předchozího HTTP permitu.
  Absence nebo chyba instalace vrací false, nikoli kladný fallback.
- Router unit sada prošla 66/66, včetně 13 nových composition/loader
  případů s mock portem nebo filesystemem. Nejde o Root důkaz.
  AI14 test předchází tomuto loaderu a **není jeho integračním testem**.
- Skutečný Root publisher, aktuální generation/read/maintenance lease,
  per-request execution context, přijatý installer, nativní delivery a
  fyzický restore/replay zůstávají společnými gates COP–SIM–správce.
  Připravená composition sama tyto závislosti nezřizuje. Nový Router se
  nesmí recreate jen s erasure flagem false: bez skutečné autority by
  správně odmítl i dosavadní chráněný COP chat/BYOK.

### Co musí být skutečně připravené před servisním oknem

SDA má nově pevný owner loader pro execution/read/context/retention
factories a stejné zapojení ve standalone úklidu. Místní sada prošla
611 PASS / 6 opt-in PG SKIP; [rozsah důkazu](../archive/2026-10-15_DRIVER_OWNER_COMPOSITION.md)
je pouze syntetická aplikační kompozice. Chybějící modul zůstává
`guarded:{}` a neotevře legacy DML. Guarded `aggregates`/`quality` jsou
zatím explicitně 503 před SQL, protože ještě chybí přijatá held
generation/publication read bariéra. Ta a inventura dříve generovaných
souborů/cache jsou další konkrétní podmínkou plné funkční akceptace;
nepovažovat krátkodobý checkpoint podpis za náhradu.

- DBA doloží pevnou DB `sim_driver_measurements`, původních sedm tabulek
  vlastněných `driver_measurements_migrator`, bez RLS, dvě původní receipt
  `ON DELETE CASCADE` vazby a původní SECURITY INVOKER receipt guard.
  Před 003 musí být `sim_driver_guard_source` prázdné a vlastněné
  `sim_driver_guard_owner`. Existující migrační owner
  `driver_measurements_migrator` se tímto postupem nemění. Předem existují
  omezené role: `sim_driver_guard_owner` NOLOGIN;
  `driver_measurements_runtime`, `sim_driver_guard_control` a
  `sim_driver_guard_exec` LOGIN; všechny čtyři bez superuser/CREATEDB/
  CREATEROLE/REPLICATION/BYPASSRLS. Jediné povolené chráněné členství je
  **guard_owner MEMBER OF guard_exec**, tedy `sim_driver_guard_exec` udělená
  ownerovi, nikoli opačně; runtime ani control se nesmějí stát ownerem.
  004 vyžaduje přijatou 003 a dosud neexistující `read_admission_facts`.
- Pro AI DBA doloží `sim_ai_router` a nezměněné 001–003, sedm tabulek a
  dvě finanční invoker views pod `ai_router_migrator`, skutečné RLS,
  fence triggery a nákladovou retenci. Před AI004 musí být
  `sim_ai_guard_source` prázdné pod existujícím NOLOGIN
  `sim_ai_guard_owner`; pevný `sim_ai_guard_control` je LOGIN bez širokých
  práv, chráněné role nemají členství a runtime je nesmí převzít.
  AI004 vytvoří jen prázdnou binding tabulku, nikoli přijatou inkarnaci.
  Před oběma 005 musí zvlášť existovat přijatý store binding a singleton.
  Tyto SQL zdroje nevytvářejí nové role, secrets, účty ani automatické bindingy.
- Správce a COP doloží skutečnou Root custody: připnuté Root-owned soubory
  readerů, native klienta a celého dependency closure pod
  `/opt/cop-account-safety`; pevný AI vstup je výše uvedený modul, ne
  app-zvolený path. Podpisový klíč a soukromé profily `registry-probe`,
  `driver-control` a `ai-router-control` zůstávají pouze u Root brokeru
  s ověřenou TLS CA/server name. Aplikace nedostává signer ani control
  credentials. DSN, cesta nebo kladný callback nesmějí být volbou HTTP.
  Tento runbook nezřizuje role, granty, secrets, HBA, sudo ani transport.
- Publisher nezávisle přijme skutečnou store incarnation, cluster/timeline,
  boot, guard-store, continuity epoch, dataset/runtime/source-proof a
  policy binding, checkpoint i přesné očekávané schema/privilege fingerprinty.
  Aktuální podepsaný frontier musí mít nezávislou kotvu a živou registry;
  očekávané piny se nesmějí automaticky schválit z téže kontrolované DB.
  Součástí je ověřená report inventory pro `no_report` nebo skutečnou
  publikační bariéru, owner-wide generation/drain a přijatý restore/replay
  gate. Prázdný výsledek, DB flag ani čerstvý hash tyto podmínky nenahradí.
- COP dodá přijatý kernelový peer transport, klientskou registraci a
  enrollment, signer/evidence a per-request delivery. Každé čtení má přesný
  čerstvý krátkodobý podepsaný read permit a čtyři evidence podle integrace 23.
  COP potvrdil per-inspect delivery v chráněném tmpfs, bez trvalé per-read
  identity historie; její skutečné nasazení se musí ověřit. Každý writer má
  svůj původní registrovaný origin, body/schema/cutoff binding a interní
  kontext právě autentizovaného volání. SIM smí zapojit pouze skutečné
  execution/admission/current-context porty a maintenance consumer;
  výchozí unbound factory ani funkce vracející kladné booleany nestačí.
- Metadata settery vyžadují vlastní explicitní maintenance/review lease,
  ne chat oprávnění. Driver005 přidá pouze šest UPDATE sloupců existujícího
  state; AI005 pouze `identity_reviewed`, `replay_ready`, `cost_policy`,
  `checkpoint_id`, `checkpoint_generation`, `updated_at`.
  Žádný runtime/control raw metadata DML,
  INSERT/DELETE, table-wide UPDATE nebo změna ledgeru/fences/keys/costs.
  Root reference se neukládá. Driver použije existující proof TTL;
  u AI je <=30sekundový deadline pouze transient, ne nový DB sloupec.
  Setter není per-chat ani náhrada čerstvého read admission.

### Jedno omezené servisní okno

1. Předem uložit přesné revize, image digesty, SQL hashe, schválené bindingy
   a přístupový profil. Až do přijetí všech závislostí zachovat stávající
   zdravé služby. Driver a AI část odvodnit odděleně: u Driveru pozastavit
   intake a všechny writery včetně revoke, erase/ACK a obou retenčních
   entrypointů. AI část potřebuje vlastní kontrolované zastavení nových
   chráněných dispatch a vypořádání přijaté práce před výměnou image.
   Driver-only krok nezastavuje Router/chat. Nikdy celý SIM, COP,
   databázový cluster nebo jiné projekty. Předem určit všechny dotčené
   cesty, nikoli jen erasure flag nebo nový intake.
   Dokončit rozpracované transakce a doložit skutečný drain/generation stav,
   ne jen zavření JavaScript callbacku nebo kontejneru.
2. Při stále pozastavených writerech provede správce připnutou 003 a poté
   004 a současně připraví guarded-kompatibilní writery. Zúžení grantů
   nesmí předběhnout jejich náhrady. 003 se nepoužívá k adopci neznámého
   existujícího namespace; skutečnou inkarnaci sváže Root, nikoli app UUID.
   004 je privátní control-only EXECUTE v `BEGIN READ ONLY`, STABLE, bez
   probe/seal, DML nebo explicitních row/advisory zámků.
   Driver005 až po skutečné předvazbě aplikuje root-reviewed checkpoint
   přes CAS předchozího hashe; null pouze při skutečně null počátku.
   AI004/005 se připraví odděleně nad nezměněným Router schématem.
   AI005 porovná skutečné checkpoint ID/generaci a dovolí jen přesné +1
   jako bigint text bez overflow. Oba settery mají 1s lock timeout,
   aktivní/karanténní režimy a proof platný po zámku nejvýše 30 sekund.
   Reference/DB flags nejsou podpis; skutečnou autoritu před voláním
   ověřuje Root. Nejistý apply se nesmí řešit slepým novým CAS.
3. Ověřit přesný runtime profil: SELECT pouze na sedmi jmenovaných Driver
   tabulkách, INSERT pouze receipts/intervals/eta a UPDATE pouze sloupce
   `driver_measurement_receipts.receipt`, plus původní receipt-guard EXECUTE.
   Žádné runtime DELETE/TRUNCATE, ledger/fence DML, REFERENCES/TRIGGER,
   CREATE/TEMP, CREATE ve schématu ani USAGE/EXECUTE privátního guard RPC.
   Žádné table/column granty nebo SELECT pro PUBLIC, žádné `ALL TABLES`
   rozšíření; ověřit i účinná zděděná práva. Read facts EXECUTE má pouze
   `sim_driver_guard_control`, nikoli runtime, executor nebo PUBLIC.
   AI zachová vlastní dosavadní úzký aplikační/RLS profil, nikoli Driver
   granty; checkpoint SQL má EXECUTE pouze `sim_ai_guard_control`.
   Root-only šestisloupcový UPDATE se nesmí změnit na runtime/table DML.
4. Přijmout skutečné post-migration fingerprinty nezávislým publisherem a
   zapojit stores s interní opt-in volbou `guarded`. Ověřit všechny čtyři
   writer cesty i pět read purposes, actor/operation binding a aktuální
   podpisy před i po SQL. Read admission má nejvýše pět sekund a nepřekročí
   platnost permitu/evidence/registrace/frontier/proofs; nenahrazuje drženou
   generation/read lease. Běžný HTTP GET nesmí spustit resolution/seal.
   Nejasný COMMIT nebo restart pokračuje jen probe stejného originu.
   Po každém 005 je nutný nový nezávisle přijatý privilege pin; starý pin
   musí selhat, nikoli se automaticky přepsat hodnotou z kontrolované DB.
   U AI musí následné fresh read-only 004 doložit actual snapshot digests;
   pětipolový checkpoint uvnitř setter odpovědi je sám neobsahuje. Instalovaný production
   loader pak musí ve skutečném cílovém image projít vlastní akceptací.
5. Teprve po společné akceptaci COP–SIM–Root obnovit dotčené části provozu.
   Doložit revokaci s původním scalar receipt, erase→202→samostatný ACK,
   retention s neměnným cutoff, souběh s intake, výpadek a recovery; bez
   testovacího smazání reálného účtu. Zkontrolovat ostatní SIM/IZS API,
   routing, stávající COP AI cestu a nezměněné finanční limity. Pokud binding
   nebo reader chybí, chráněná větev zůstává unavailable, nikoli legacy,
   přímý OpenAI nebo kladný verifier fallback. U AI zvlášť ověřit BYOK
   GET/PUT/DELETE, chat i legacy cestu, šifrování klíče, původní plátce,
   limity a pozdní náklad bez provider obchvatu. Nezávislé zdravé služby
   i shared SIM/IZS identita zůstávají zachované.

### Akceptační hranice a návrat

[14 PASS v novém PostgreSQL ověření](../archive/2026-10-15_DRIVER_READ_ADMISSION_SQL.md)
dokládá read-only SQL fakta, ACL a nulové vedlejší efekty v soukromém
syntetickém clusteru. Nedokládá skutečný Root permit/signature/peer,
enrollment, produkční wiring ani obnovu.
[15 nových Linux případů](../archive/2026-10-15_DRIVER_READ_ROOT.md)
ověřilo skutečný reader, podpisy, custody, TLS/SQL a timeout nad
syntetickými profily, registry a peer. Jde o původní zmrazenou evidenci.
Navazující Driver keyring/trust-set oprava prošla [novou samostatnou
16případovou sadou](../archive/2026-10-15_DRIVER_READ_KEYRING.md).
Starý výsledek zůstává beze změny; nový test není deterministický race
test rotace uvnitř podpisu ani produkční config/generation lease.
[Driver005 8/8](../archive/2026-10-15_DRIVER_ROOT_CHECKPOINT_SQL.md)
a [AI Root 14/14](../archive/2026-10-15_AI_ROOT_CHECKPOINT.md) jsou vlastní
oddělené source důkazy s výše uvedeným rozsahem. AI14 nepokrývá později
přidaný production loader; 66/66 unit testů včetně 13 nových mock
composition případů nenahrazuje jeho skutečné native acceptance.
Produkční přijetí skutečné kotvy, owner evidence, nativního klienta
a obnovy zůstává otevřené; fixture je
nenahrazuje. Bez těchto provozních výsledků cutover neoznačit za
akceptovaný ani nepovolit běžné nové chráněné dispatch.

Před 003 lze vrátit původní image při zachovaném původním režimu. **Po 003
není rollback návrat k blanket DELETE/UPDATE, legacy apply/recover grantům
nebo starému writeru.** Zastavit nové dispatch, bezpečně uzavřít admission
leases a vyřešit již přijaté původní originy chráněným resolution tokem;
timeout se nesmí opravit novým UUID, cutoffem nebo opakováním DELETE.
Zachovat ledger, permanentní i dočasné fences, origin/scalar receipts,
audit a finanční stropy. Použít pouze poslední guarded-kompatibilní image,
nebo nechat Driver pozastavený a ostatní služby běžet. Restore nesmí vrátit
data přes existující fences ani obejít quarantine/replay gate.
U AI zachovat původní finanční rezervace/rollupy, RLS a permanentní fences.
Chybějící native klient se neopravuje návratem k nechráněnému chatu,
blanket checkpoint grantem, automatickým přijetím nového pinu nebo
resetem generace. Bez kompatibilního přijatého image zůstanou pozastavené
jen dotčené COP cesty; nikoli účet a přístup do nezávislého SIM/IZS.

AI provisioning skript při nalezeném namespace `sim_ai_guard_source`
odmítne legacy `--apply` i `--recover` ještě před rotací přístupových údajů
nebo udělením grantů, včetně částečné chráněné instalace. `--check` je
pouze čtecí detekce, nikoli ověření runtime profilu, Root readiness nebo
aktivace. Výpadek či neplatná odpověď namespace kontroly nesmí otevřít
legacy recovery; ochranu neobcházet ruční rotací či blanket grantem.
Osm scénářů `scripts/test-ai-provisioning-guard.mjs` prošlo s úplným
zachycením `psql` a `openssl`, bez skutečné DB nebo vytvoření přístupů.
Je to kontrola CLI flow, nikoli další PostgreSQL nebo Root důkaz.

## Rozsah a aktuální gate

Zdrojová větev `codex/sim-account-erasure-release` vychází z nasazeného SDA
`03b842e`. Nenese jinou nenasaženou reportovací/pilotní větev. Uživatel
schválil omezené migrace a nasazení **po společném ověření**. Nejde o
souhlas k testovacímu smazání skutečného účtu, ke změně COP chatu nebo k
OpenAI volání. Společný Keycloak účet, relace a SIM/IZS zůstávají zachované.

Chráněná infrastrukturní autorita obnovy zatím není zřízená. Výchozí
produkční verifier je nedostupný: `restoreCheckpointCurrent=false`.
Env flag, časově platný soubor, owner DB boolean, hash či syntetický podpis
nejsou náhradou. Nasazení kódu není aktivace mazání; nová operace bez
aktuálního skutečného důkazu nesmí vytvořit ani fence.

Vlastník 14. 10. 2026 schválil přípravu a ověření této samostatné
infrastrukturní ochrany se správcem. Následně samostatně schválil prázdnou
`cop_account_safety_guard` a sedm NOLOGIN metadata rolí; správce jejich
zřízení doložil receipt z `2026-10-14T08:26:39Z`, SHA-256
`03012e09198dbcca73bb38fcd263cdb1bce2aab582adcd78c54e242a83230177`.
Migrace `a29369e48a1380bb12ce3b40b9254d924e0d98a3b90f7cdcdc0fb7e9ba27aaba`
vytvořila devět prázdných tabulek; nevytvořila LOGIN, členství nebo
enrollment. Původní role a členství zůstaly stejné. SIM zdrojový vlastník
ověřil obsah a hash receipt, nikoli druhý živý DBA audit.
Tato metadata DB není aplikační per-principal fence store a nesmí se na ni
přesměrovat aplikační DB URL. To neruší produkční gate: skutečné
umístění autority, omezené technické role, secrets, privátní transport,
enrollment a consumer wiring musejí být konkrétně připravené a schválené.
Zdrojový návrh a izolovaný kryptografický/SQL test nejsou existující
produkční autoritou. Nezřizovat tyto objekty pod aplikační migrací 002/003.

**Aktuální release není způsobilý k přepnutí produkčního Routeru:** nové
chráněné COP cesty vyžadují skutečný owner verifier i při prázdném ledgeru.
Jeho absence by správně vrátila 503 i pro dosavadní COP chat. Nepřepnout
obraz pouze s erasure flagem `false` a nepovažovat to za bezpečné nasazení.
Nejprve dokončit zvlášť schválenou autoritu a společnou akceptaci; stávající
zdravé služby se do té doby zachovají.

Stejné omezení platí pro nový Driver retention lifecycle. Konstruktor již
nespouští časovač. API composition zahájí úklid jen po skutečném init a
owner-bound maintenance consumeru; samostatný cron entrypoint nemá přímý
SQL bypass. Pevný zdrojový loader je připravený, ale skutečný produkční
consumer zůstává nepřijatý/unbound, takže nový SDA obraz nesmí nahradit
stávající pouze s vypnutým intake. Jinak by ustal retenční úklid bez
přijaté náhrady. Chybějící maintenance závislost neodstaví ostatní SIM/IZS
API a neuděluje oprávnění příjmu nebo mazání účtu.

Před nasazením ověřit přijatý consumer i obě jeho cesty, replay a cutoff,
retenci v revocation-only a close s rozpracovanou SQL transakcí. Úklid dvou
dočasných tabulek musí mít jeden immutable cutoff a jednu transakci;
permanentní fence/ledger se nesmějí smazat. Čekání na callback při close
nenahrazuje nativní drain, známý abort nebo restore akceptaci.

Linux peer/socket wrapper a jeho skutečný protocol/owner wiring nejsou
zřízené. Přesná zdrojová mapa a potřebné per-principal i owner-wide
hranice jsou v [integraci 22](../integration/22_COP_ACCOUNT_ERASURE_CONTRACT.md#napojení-na-chráněnou-nativní-autoritu).
Aktuální místní PostgreSQL HBA používá podle infrastrukturního auditu
`trust`, ne OS `peer`; přístup k socketu sám nepotvrzuje skutečnou roli
root brokeru. Před aktivací autority řešit zvlášť schválené autentizační
zpevnění, nikoli v SIM měnit HBA nebo vydat pozitivní verifier.

Nově dodaný `cop-actor-peer-isolated-v1` je pouze zmrazený source/fixture
ABI. Jeho offline klient není runtime transport, enrollment ani verifier;
`productionReady=false` zůstává povinné i po úspěšné testovací odpovědi.
V1 nesmí být automaticky použit pro jinou verzi wrapperu. Pro skutečný
provoz stále chybí peer/kernel/lifecycle akceptace, aktuální Root authority,
owner-wide replay/generation, skutečné identity a side-effect settlement.

Nejmenší další zdrojový krok je konkrétně rozepsaný v
[integraci 23](../integration/23_SIM_ACCOUNT_SAFETY_RUNTIME_PREPARATION.md).
Její [neaktivní manifest](../integration/23_SIM_ACCOUNT_SAFETY_INACTIVE_INSTALL.json)
mapuje 17 existujících HTTP operací a 32 přesně připnutých souborů; nemá
schválený cílový adresář/owner/mode/archive ani proveditelné actions.
Samostatné přijetí neaktivního balíčku nevyžaduje předstírat hotový B2
producer, ale potřebuje svůj přesný souhlas; následná aktivace/wiring mají
další společné gates. Compose, runtime flags, klíče a role se nyní nemění.
Lokální retention lifecycle a composition mají samostatný
[ověřovací záznam](../archive/2026-10-14_DRIVER_RETENTION_LIFECYCLE.md);
37 cílených syntetických případů nedokazuje přijetí produkčního consumeru.

Koordinovaný source patch driver operací má od 15. 10. samostatné
[ověření 18 PostgreSQL případů](../archive/2026-10-15_DRIVER_GUARDED_OPERATIONS_SQL.md).
Přidává fixed-origin revoke/erase a control-only readback s typovaným ACK;
neaktivuje ale skutečného Root producenta nebo restore. Nasazení samotného
`003_guarded_operations.sql` by před přechodem writerů odebralo potřebný
přímý DELETE a je zakázané. Legacy provisioning po guarded přechodu
odmítne apply/recover, takže návrat nesmí být opětovným širokým grantem.
Při rollbacku zachovat ledger/fences, zastavit nové chráněné operace a
zjišťovat nejasné původní origin výsledky; starý obraz s požadavkem na přímé
DELETE není kompatibilní návrat po tomto přechodu.

SDA už obsahuje konkrétní opt-in guarded náhrady erase, ACK, revoke a
retence. Jsou přístupné pouze interními constructor/dependency volbami;
nový env přepínač nebo produkční Root factory nevznikly. Bez skutečného
execution/admission/current-context portu jsou nedostupné. Původní režim
se zachovává pouze před koordinovanou migrací, nikoli jako fallback
po selhání guarded větve. Konkrétní předání je v integraci 23 a lokální
[ověření aplikace](../archive/2026-10-15_DRIVER_GUARDED_APPLICATION.md)
není společná produkční akceptace. Samotná publikace zdroje nevyžaduje
recreate kontejneru, instalaci 003 nebo změnu secrets.

Správce později doložil úzkou skutečnou invocation/public-package inventuru
Patroni v 13:44 Praha. SIM ověřil oba receipts d6a0834d… / 7bf2ff93…;
známá gramatika a dpkg vlastnictví šesti vybraných souborů jsou doložené.
To není loaded-module attestation, přesný DCS CAS, effective auth,
uzavření celé A1/A2, independent anchor nebo runtime enrollment.
Aktivace autority z tohoto výsledku automaticky neplyne.

Správce následně doložil devět skutečných vlastních neprivilegovaných
Linux fixture testů, včetně socket credentials, přijatých deskriptorů,
smrti procesu a čekající lease. Jeho `ROOT-LINUX-RESULTS.json` má SHA-256
`496f4931122e59c1305e3214fe6228ac036d7672309a8bf21cc93c7f8440f6f2`;
SIM ověřil obsah a hash, nikoli druhý Linuxový běh. Tento v2 harness
není owner-wire ABI v1 ani produkční služba. Atomické pořadí runtime
generation/commit/fence, skutečný bootstrap, owner-wide replay a restore
zůstávají otevřené. Návrh zpevnění PostgreSQL `trust` na `peer` je pouze
source plán; jeho provedení, HBA reload a nové provozní přístupy nejsou
aplikační migrací a vyžadují samostatný konkrétní krok.

## Ověření zdrojů

V odděleném pracovním stromu:

```sh
pnpm --filter @csm-sim/observability build
pnpm --filter @csm-sim/situation-data-api typecheck
pnpm --filter @csm-sim/ai-router-api typecheck
pnpm --filter @csm-sim/situation-data-api test
pnpm --filter @csm-sim/ai-router-api test
pnpm --filter @csm-sim/situation-data-api build
pnpm --filter @csm-sim/ai-router-api build
pnpm openapi:build
pnpm openapi:validate
node scripts/test-account-erasure-contract.mjs
bash scripts/validate-skeleton.sh
```

Izolované PostgreSQL testy musí mít soukromý prázdný data directory,
Unix socket bez TCP, omezené runtime role a guard proti záměně s jiným
clusterem. Pozitivní testovací verifier je pouze závislost testu.
Test skutečného restore/PBS, frontendový dojem ani zdravý kontejner nejsou
nahrazeny schématickými testy.

Reprodukovatelný PostgreSQL 18.3 test má vlastní nový cluster a nepřijímá
DB URL nebo host. Na Macu s připnutým Node 24 a PostgreSQL binaries:

```sh
PG_BIN=/opt/homebrew/opt/postgresql@18/bin node --import ./apps/ai-router-api/node_modules/tsx/dist/loader.mjs scripts/test-account-erasure-postgres.mts --run
```

Runner ověří soukromý data directory, socket, skutečnou serverovou identitu,
chybějící TCP listener a SHA-256 všech pěti migrací. Zablokuje `fetch`,
nepřebírá PG/AI secrets z prostředí a po úspěchu zastaví a odstraní pouze
svůj vygenerovaný syntetický cluster. Neúspěšný test ponechá soukromý
fixture pro diagnostiku. 41 těchto kontrol dne 14. 10. 2026 prošlo;
není to důkaz skutečné produkční obnovy ani vydání Root autorizace.

Společný zdrojový HTTP test importuje pouze čistý a přesně připnutý COP
checkout a spojuje skutečné COP adaptéry se skutečnými Express handlery
SIM přes dočasný loopback. Stores, ověření identity/autority a publikační
barrier jsou výslovně syntetické. Externí volání, intake, model a matcher
jsou zakázané. Tento test nenahrazuje nativní PostgreSQL ani produkční
Root/restore akceptaci:

```sh
node --import ./apps/ai-router-api/node_modules/tsx/dist/loader.mjs scripts/test-cop-sim-erasure-http.mts --run --cop-source /absolute/reviewed/COP/checkout
```

Použít Node 24 také v podprocesech. Nová COP revize vyžaduje zvláštní
zdrojovou revizi a aktualizaci pinů; dirty nebo jiná revize skončí před
importem COP a otevřením portu. Výsledek rozlišuje syntetickou HTTP
akceptaci od produkční autorizace. Před produkčním rozhodnutím zaznamenat
v archive přesnou dvojici zdrojových revizí, hashe a skutečný rozsah testu.
Aktuální dvojice a důkazy jsou v [navazujícím zdrojovém ověření](../archive/2026-10-14_COP_SIM_ERASURE_HTTP_CORRECTION.md).

Přímý adaptér/handler test nepokrývá celý COP controller. Nový release
musí zvlášť ověřit první předání skutečně potvrzeného durable COP jobu
při zapnuté ordinary readiness i pokračování vlastní přijaté operace
při vypnutém příjmu. Cizí/neexistující SIM receipt nesmí udělit oprávnění
k resume a výpadek či timeout readiness nesmí být zaměněn za povolení.
Dosavadní archivní dvojice a počet 10 HTTP scénářů se nepřepíšou výsledky
nové orchestrace nebo nepublikované COP revize.

Pro novou čistou COP revizi `898cd5132f513259b226d5beff5c3876156b56e7`
existuje samostatný runner skutečného řadiče, consent composition a obou
COP adaptérů proti skutečným SIM handlerům. Spouštět jen s Node 24:

```sh
node --import ./apps/ai-router-api/node_modules/tsx/dist/loader.mjs scripts/test-cop-sim-erasure-controller-http.mts --run --cop-source /absolute/reviewed/COP/checkout
```

Stores, identity, native authority, publication a ostatní vlastníci jsou
syntetické; veřejný login, COP HTTP routes, iPhone a produkční DB nejsou
ověřené. Test zahrnuje čekající 202, staré outbox dny, vlastní flag-off
resume a skutečný restart řadiče po local purge, ale před global checkpoint
commitem. Následující Driver kontrola musí být GET-only, bez rekonstrukce
odstraněných dnů a bez nového POST. Historické 10/71 důkazy původního
adaptér testu zůstávají samostatné.

Offline v1 klient je opt-in test bez sítě, procesu, native transportu nebo
databáze. Externí wrapper checkout musí odpovídat připnutým hashům:

```sh
node --import ./apps/ai-router-api/node_modules/tsx/dist/loader.mjs scripts/test-isolated-native-peer-client.mts --run --wrapper-source /absolute/reviewed/isolated-linux-wrapper
```

Ani úspěšných 61 memory/codec případů a 8 controller HTTP scénářů nezapíná
produkční verifier, chat, mazání nebo obnovu. Přesné piny a rozdělení
ověřených a neověřených vlastností zaznamenat v samostatném archive;
počty se nesčítají s historickými native/SQL testy.

Zmrazený vlastní rerun SIM a přesná dvojice s COP 898 jsou v
[oddělené evidenci řadiče a peer fixtures](../archive/2026-10-14_COP_SIM_CONTROLLER_AND_PEER_FIXTURES.md).

Doplňková [regresní evidence COP](../archive/2026-10-14_COP_REGRESSION_FOLLOWUP.md)
v docs-only komitu ce052cf runtime 898 nemění. Její sjednocených 2 429
PASS / 8 SKIP vzniklo z původního neúspěšného úplného běhu a cíleného
PostGIS recovery; není to jedna bezchybná úplná sada ani produkční gate.

### Samostatné V5 porovnání Node–Python

V5 má oddělené schéma, codec a fixture klienta; neprovádět migraci v1/v4
ani přepis jejich archivních počtů. Před importem ověřit přesné externí
source piny, Node 24, Ajv 8.20.0 a reviewed Python bridge. Spuštění je
výslovně opt-in:

```sh
node --import ./apps/ai-router-api/node_modules/tsx/dist/loader.mjs scripts/test-dormant-fixture-companion.mts --run --boundary-source /absolute/reviewed/dormant-boundary-v5
```

Runner nepřijímá executable, URL nebo credentials. Jeden pevně zvolený
Homebrew Python s `-I -S -B` dostane hash-verified bridge bytes a syntetické
STDIN zakončené EOF. Maximum vstupu/výstupu je 1 MiB, stderr 16 KiB;
rodič má limit 5 sekund. Po přečtení osmi přesně připnutých souborů Python
audit odmítne late open, socket, SQLite, další subprocess a datové změny.
Volají se pouze decoder, canonical frame, frame/correlation digest,
result a error encoder; registry, core, native dispatch nebo DB se nepoužijí.

Výsledky ověřují čtyři emitované syntetické páry a vlastnosti přísného
parseru, response vztahů a omezené paměťové výměny. Schema-only PASS
neprokazuje duplicate-key/float token kontrolu ani cross-field vztahy.
Parent timeout není watchdog nativního COMMIT. Node fetch counter není
obecný OS síťový sandbox; reviewed codec moduly proto nesmějí dostat nové
transportní či aplikační importy bez nové revize. Všechny actual flags,
`acceptedWire` a `productionReady` zůstávají false.

Návrh budoucího transportu je v [integraci 22](../integration/22_COP_ACCOUNT_ERASURE_CONTRACT.md#návrh-nejmenšího-nativního-transportu-pro-node).
Žádný addon, socket listener, nová závislost, produkční verifier, enrollment
nebo wiring není tímto krokem vytvořen. Jeho skutečná akceptace patří do
odděleného konkrétního infrastrukturního balíčku a společného testu COP–SIM.

Vlastní finální běh SIM má 88 PASS / 0 FAIL, 60 čistých Python helper
jobs a 17 memory exchanges; přesné piny a omezení jsou v
[oddělené V5 evidenci](../archive/2026-10-14_DORMANT_V5_CODEC_CONFORMANCE.md).
Root 34 a v1 61 se k tomuto počtu nepřičítají.

## Před aktivací

1. COP doloží přesnou stávající derivaci Router aliasu, issuer, všechny
   používané driver HMAC verze a retained/outbox dny. Unknown znamená
   blokovaný preflight; nesmí se změnit derivace na nový prázdný namespace.
2. Správce infrastruktury doloží autoritativní fence nezávislé na
   obnovované aplikační DB, přijatou projekci/replay bez mezer, skutečný
   dataset/incarnation a aktuální image/policy, vynucenou admission/drain
   bránu a restore karanténu. Návrhové metadata/JWS není existující autorita.
   Neobnovuje se pouze pending fronta: přehrávají se i dříve dokončené fence.
3. U reportů je nutná inventura všech writerů, readerů a kopií. `no_report`
   nedokazuje jen absence modulu ve zdroji; alternativy vyžadují skutečný
   jediný writer nebo sdílenou generační ochranu.
4. Retence `aggregate-costs-current-month-v1` je schválená. Neuzavřená
   provider rezervace ale nesmí být automaticky dokončena podle času.
5. S COP ověřit syntetickou identitu A/B, příjem a revokaci, čisté status
   GET, retry, dávku/klíč/rezervaci závodící s mazáním, správné 202,
   nedostupný proof/DB a zachovaný přístup do SIM. Bez skutečných jízd,
   OpenAI nebo smazání skutečných účtů.

## Omezená migrace a obraz

- Zaznamenat přesné aktuální ID SDA a Router obrazu, zdrojovou revizi a
  neměnné env/mount/network nastavení. `.env` a keys nikdy nevypisovat.
- Před změnou ověřit X5 UUID `2f93f595-b61b-4eea-9054-7afa9b275b5b`,
  samostatný mount a místo. Neměnit síť, veřejné porty nebo jiné projekty.
- Oba nové erasure přepínače držet `false`; příjem Jízdy, shadow režim,
  běžná revokace a chat mají vlastní dosavadní nastavení.
- Migrace provést pouze migrator účtem přes existující HAProxy do přesně
  `sim_ai_router` (003) a `sim_driver_measurements` (002). Žádný runtime
  superuser/DDL, žádný `SECURITY DEFINER`, žádné hromadné DELETE.
- Router 003 vyžaduje nový kompatibilní writer a finanční čtení rollupů.
  Zastavit pouze tento Router po odvodnění in-flight požadavků, aplikovat
  migraci a spustit ověřený nový image. Starý Router nesmí mezitím zapisovat.
  SDA vyměnit pouze cíleně po ověření 002. Nezastavovat Docker daemon,
  PostgreSQL, COP nebo jiné služby.
- Runtime dostává pouze aktuální bearer/HMAC secrets a omezenou DB URL.
  Migrační přístupy zůstávají u správce. Nevyměňovat účty ani klíče
  poskytovatele; nezavádět přímý náhradní přístup do OpenAI.
- Zaznamenat konkrétní nasazenou revizi/image a výsledek health/API.
  Capability musí bez autority poctivě vracet `ready:false`; následný
  POST je ochranná 503 bez vytvoření nové operace.

## Interní cesty a důkazy

SDA direct: `/api/v1/internal/driver-measurements/v1/account-erasure-operations`.
Router: `/api/v1/ai-router/cop/users/me/erasure-operations`.
Obě mají `/capability`, `/preflight`, POST start a GET `/{operationId}`.
Přesné adresy/porty se přebírají z dosavadního serverového adaptéru COP;
nesmí vzniknout veřejný port. Fragment v závazném OpenAPI používá u SDA
kompozitní prefix `/situation-data`.

Počítat 401 bez bearer, 403 browser/jiná služba, 400 vadný vstup,
404 cizí/neexistující operace, 409 vlastní immutable konflikt, 429 a 503.
200 z capability/preflight znamená provedenou kontrolu, ne smazání.
200 online receipt neznamená vymazání záloh/poskytovatele ani shared SIM.

## Návrat a incident

Erasure ledger a trvalé fence se při rollbacku nemažou, neexpirují s
měřeními a neobnovují ze staré aplikační zálohy bez autoritativního replay.
Pokud aktuální verifier není dostupný po první operaci, chráněné COP
vstupy zůstávají blokované. Nezávislé SIM/IZS funkce se plošně nevypínají.

Nepřepnout automaticky na starý image: nezná nové finanční rollupy a
ochranu mazání. Použít jen ověřený kompatibilní rollback nebo zastavit
dotčené COP vstupy a opravit dopředu. Obnova vyžaduje aktuální externí
fence a kontrolu skutečného cílového datasetu; TTL historického proofu
nepovoluje návrat. Při nejistém provider nákladu zachovat pending a
konzervativní finanční rezervaci, nikoli vymazat účetní strop.
