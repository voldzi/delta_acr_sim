# Nasazení mazání COP/Jízdy při zachování SIM

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
