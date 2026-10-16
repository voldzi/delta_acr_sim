# DBv2: akceptace mazání COP/Jízdy

Aktivní zdrojová cesta je [ADR0040](../adr/0040_DATABASE_BACKED_ACCOUNT_ERASURE.md).
Produkční **disabled-only SIM instalace** je doložená 16.10.2026; aktivace
celého mazání COP není dokončená. Root/native instalace není její podmínkou.
REST `sim-account-erasure-v1`, identity SIM/IZS a finanční retence se nemění.

## Přesné soubory a konfigurace

- Driver: původní schéma + SQL002 a povinná
  `008_eta_contributor_binding_database_v2.sql`. ETA/parent mismatch končí
  23514 bez opravy dat; Root003–006 se kvůli tomu neinstaluje.
- AI: SQL001–003; rezervace `reserved`/`uncertain` zůstávají pending.
- Nezávislá DB `cop_account_safety_guard`: SIM migrace
  `010_sim_database_safety_v2.sql`; legacy COP tabulky se nemění.
- Oba targety: `011_sim_target_binding.sql`, explicitní admin enrollment
  shodných config/store/incarnation/checkpoint/generation, runtime SELECT-only.
- Explicitní mód `SIM_ACCOUNT_ERASURE_AUTHORITY_MODE=database_v2`.
  Default `root_native_v1` se nemění; selhání nemá automatický fallback.
- Dvě oddělené secrets URL `DRIVER_ERASURE_GUARD_DATABASE_URL` a
  `AI_ROUTER_ERASURE_GUARD_DATABASE_URL`; Compose je předá odpovídající
  službě jako `SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL`. Nesenzitivní piny:
  `SIM_ACCOUNT_ERASURE_GUARD_STORE_ID`, `SIM_ACCOUNT_ERASURE_CONFIGURATION_FINGERPRINT`.

## Jeden koordinovaný instalační krok

### Skutečný stav 16.10.2026

Člověk po minimální instalaci jediného klientského balíčku
`postgresql-client-18=18.6-0ubuntu0.26.04.1` úspěšně provedl původní
hashově připnutý stage `ca1fd6b-v2` ze zdroje `d40fc72`. Starý stage se
nepřepisoval. První pokus předtím selhal, protože existoval jen Ubuntu
`pg_wrapper` bez skutečného klienta; `command -v psql` tuto závislost
neověřil. Simulace balíčku ukázala 1 nový klient, 0 aktualizací, 0 odstranění
a žádný PostgreSQL server. Agent nic neinstaloval ani neopakoval apply.

Nové skutečné SDA/Router obrazy odpovídají přesným `ca1fd6b` image IDs
uvedeným níže. Nezávislá čtecí kontrola ověřila oba autentizované capability
endpointy HTTP200, bez tokenu HTTP401, `database_v2`, oba erasure flags false,
`enabled=false/ready=false` a všechny strukturální checks true. SDA má
`shared_generation_fence` a `publicationFenceVerified=true`; Router zachoval
`aggregate-costs-current-month-v1`. Oba live/ready endpointy vracejí 200/ok,
SDA routing i DEM jsou ok bez degraded sources a veřejná domovská SIM vrací
200. Neobsahové environment digesty přesně odpovídají předinstalačním;
actor/hash/encryption/provider konfigurace a původní intake se zachovaly.

Přesný [produkční čtecí receipt](../archive/2026-10-16_SIM_DATABASE_V2_DISABLED_PRODUCTION.json)
odděluje skutečné ověření od člověkem předaného `complete_disabled` JSON.
Soukromý Root post-stop inventář se nekopíroval a nebyl nahrazen smyšleným
digestem. Nebyl smazán skutečný účet ani zapnut whole flag.

Oddělená zdrojová oprava pro **budoucí** balík již před skrytým promptem
spouští konkrétní PG18 `--version` pod pevným PATH bez credential env a
PostgreSQL SSLRequest + hostname/CA ověřené TLS bez loginu/SQL. Native
klientská cesta je `/usr/lib/postgresql/18/bin/psql`. Nepropouští raw stderr;
vrací jen allowlistované client/auth/TLS/DNS/refused/timeout/SQLSTATE kódy a
statickou preflight podfázi. Neznámá chyba zůstává UNKNOWN, bez výpisu údajů.
Tato oprava nemění již použitý stage, nasazené obrazy ani vyžaduje další apply.

Konkrétní administrátorský vstup je
`scripts/provision-sim-erasure-production.sh`. Není to runtime služba,
nežádá další databázi, nemá síťový fallback a sám nestartuje kontejnery.
Používá existující `cop_account_safety_guard` přes `haproxy.home.cz:5000`.
Produkční skript vyžaduje Root a PostgreSQL administrátora; heslo se zadá
skrytě na terminálu nebo je předá již běžící společný Root postup v env.
Heslo ani nové guard přístupy nejsou ve výstupu, argumentech či Gitu.

Správce/COP sestaví **jednu** společnou údržbu s těmito kroky:

1. Připravit přesný publikovaný SIM commit v novém release adresáři, ověřit
   jeho revizi a sestavit oba obrazy. Nenahrazovat ani resetovat dirty
   `/srv/sim`; obsahuje vlastní provozní změny Compose, OTEL a deploymentu.
   Zapsat přesné lokální image IDs (ne pohyblivé tagy) jako
   `SIM_ERASURE_DRIVER_IMAGE` a `SIM_ERASURE_ROUTER_IMAGE` do chráněné
   release konfigurace. Síť, veřejné porty, ostatní služby a existující X5 mounty neměnit.
2. Do existujícího chráněného `/srv/sim/.env` koordinovaně připravit chybějící
   actor secrets/issuery pro obě služby. Existující
   `DRIVER_MEASUREMENTS_HASH_SECRET`, `AI_ROUTER_USER_HASH_SECRET` ani
   uživatelské šifrovací klíče nerotovat. Actor secret nesmí nahradit službový
   bearer; COP musí používat shodné účelově omezené podepisování.
3. Nastavit cestu ke **stávající schválené veřejné CA**, například
   `SIM_ERASURE_PG_ROOT_CERT_FILE=/etc/vcode-cop-pgbouncer/postgres-ca.crt`.
   Root čte pouze veřejný PEM, nikoli privátní klíč. Všechny instalační TCP
   příkazy vynucují `PGSSLMODE=verify-full` a tutéž explicitní CA, bez ohledu
   na zděděný `PGSSLMODE`; neověřený certifikát/jméno znamená konec.
4. Spustit `--check`. Jde pouze o čtení; vrátí chybějící konfiguraci,
   skutečné schema a fingerprinty. Podle skutečně zkontrolovaných vazeb
   připravit Root-owned mode600 enrollment JSON z
   `deploy/account-safety/production-enrollment.example.json`. Šablona je
   záměrně neplatná. UUID/store/incarnation/checkpoint/generation přijímá
   správce výslovně; při existujícím enrollmentu se přebírají pouze jeho
   přesné hodnoty. Digest identity review odkazuje na skutečný důkaz
   COP subject → router alias / contributor namespace; náhodný digest ani
   samotné `identityReviewed=true` tuto kontrolu nenahrazují.
5. Zastavit pouze existující `csm-sim-situation-data-api` a
   `csm-sim-ai-router-api`; ne Docker daemon ani ostatní projekty. Až potom
   `--apply --enrollment /root/<reviewed-file>.json`. AI SQL003 vyžaduje
   kompatibilní writer i při vypnutém mazání, proto nesmí běžet původní
   Router pod novými triggery.
   V témže již schváleném Root postupu poté spustit `--inventory-reports`
   (nepotřebuje PostgreSQL heslo). Ověří skutečné X5 UUID a jiný device než
   `/`, soukromý measurement report adresář, metadata souborů a skutečně
   přečte `/etc/crontab`, `/etc/cron.d`, root/user crontabs pod
   `/var/spool/cron/crontabs`, systemd unit soubory a odpovídající procesy.
   Do výstupu nedává report filenames/obsah, cron obsah ani process args.
   Správce musí navíc zkontrolovat případné nepřímé/ad-hoc producenty;
   nulový automatický match není důkaz o libovolném privilegovaném programu.
   Při producer matchi, běžícím writeru nebo zbylém `.publication-lock`
   installer report enrollment odmítne. Žádnou cizí službu automaticky
   nevypíná. Nezbytná oprávnění jsou root:root 0700 pro přesný report
   adresář/podadresáře a soukromé root soubory; mimo tento rozsah nic neměnit.
   `reportPublication` v manifestu vyplnit teprve po skutečném review,
   s přesným aktuálním `inventoryDigest`. Změna inventáře před apply odmítne.
6. Skript atomicky zachová ostatní `.env` hodnoty a mode600, uloží nové
   guard credentials přímo tam a použije SQL002+008+011 Driver,
   SQL003+011 AI a oddělené SIM schema010. Vlastní pouze NOLOGIN
   `sim_erasure_guard_owner` a dva omezené guard runtime účty bez členství.
   Nevytváří DB, nepřebírá `cop_guard_owner`, nedotýká se `cop_guard`.
   Opakování stejného přijatého manifestu nerotuje hesla. Cizí binding,
   quarantine, starší nezařazená historie nebo ETA mismatch se neopravují
   automaticky. Částečné selhání ponechá služby zastavené; po zjištění
   příčiny se opakuje tentýž manifest, ne nový namespace.
7. Ke **každé službě samostatně** připojit
   `deploy/account-safety/database-v2.prepare.compose.yml` za její stávající
   Compose soubory. Dne 15.10.2026 měl SDA navíc X5 + driver-measurements
   overlay, Router X5 + ai-router overlay; použít aktuální container labels,
   ne sjednocení naslepo. Overlay předá oba target DSN i guard DSN a přidá
   read-only public CA mount na `/etc/csm-sim/postgresql-ca.pem` a jen SDA
   úzce omezený RW report bind z přesného X5 adresáře na
   `/driver-measurement-reports` (`create_host_path=false`). Žádná obecná
   host složka, Docker socket či jiná služba tento přístup nezískává.
   Target i guard TCP mají explicitní
   `sslmode=verify-full`; produkční loadery odmítnou downgrade, jiný host,
   duplicitní či nepovolené TLS parametry i `NODE_TLS_REJECT_UNAUTHORIZED=0`.
   COP vlastní chráněný lokální PgBouncer Unix socket se tímto nemění.
8. Ověřit výslednou Compose konfiguraci **bez tisku secrets** a spustit jen
   tyto dva přesné připravené obrazy (`up -d --no-deps --no-build <service>`).
   Uložit jejich použité Compose file sety/obrazy do autoritativního
   release postupu. Legacy `scripts/deploy-docker-home.sh` odmítne při DBv2
   přepsat `.env`/celý stack; installer tento guard vloží i do stávajícího
   místně upraveného skriptu bez smazání jeho ostatních změn.

Příkazy **uvnitř schválené společné Root údržby**, nikoli další úkol uživateli:

Pro samostatnou předběžnou čtecí kontrolu slouží
`scripts/inspect-sim-root-inventory.mjs` v novém soukromém stage, nikoli
reset/pull `/srv/sim`. Ověří přesné SHA tří spouštěných souborů původního
`ca1fd6b`, Root/host/private source path a skutečně přečte pouze crontab
účtu `voldzi` (do výstupu nedává příkaz). Přijatý starý aktivní řádek má
SHA256 `c46a03b13ee8d39860fb7bd72df740006f8762fd421ded44e1b2cac990d15d78`.
Změněný nebo další measurement řádek odmítne; odstraněný/zakomentovaný řádek
označí pravdivě jako nepřítomný. Pak zavolá **stávající**
`--inventory-reports` bez PostgreSQL hesla a vrátí skutečný `inventoryDigest`.
Neprovádí SQL, editaci cron, chmod/chown, stop/start služeb ani invalidaci.
To není enrollment ani předběžné schválení publication; aktivní cleanup se
pouze zaznamená, nevypne. Root inventory provedený při běžících producentech
je nutné před skutečným apply zopakovat po jejich koordinovaném zastavení.

```sh
SIM_ERASURE_PG_ROOT_CERT_FILE=/etc/vcode-cop-pgbouncer/postgres-ca.crt \
  bash /path/to/pinned-sim-release/scripts/provision-sim-erasure-production.sh --check
# Po zastavení obou konkrétních writerů; stále pouze čtení:
bash /path/to/pinned-sim-release/scripts/provision-sim-erasure-production.sh --inventory-reports
SIM_ERASURE_PG_ROOT_CERT_FILE=/etc/vcode-cop-pgbouncer/postgres-ca.crt \
  bash /path/to/pinned-sim-release/scripts/provision-sim-erasure-production.sh \
  --apply --enrollment /root/sim-erasure-reviewed-enrollment.json
```

Instalace drží **oba erasure enabled flags=false**. Inicializuje pouze
výslovně přijatou binding/replay konfiguraci; bez přijatého skutečného
`reportPublication` inventáře zůstává Driver publication `false` a ochrana
`unverified`. S přijatým inventářem se připraví konkrétní
`shared_generation_fence` a přesný report mount, nikdy smyšlené `no_report`.
Samotná DB hodnota nestačí: factory vyžaduje skutečný chráněný adresář,
startup invalidaci a operation-bound invalidátor. Erasure flags zůstávají
false i po přijetí report ochrany.
Driver DBv2 `proof_valid_until=infinity` znamená platnost tohoto přijatého
konfiguračního checkpointu do explicitní změny binding/incarnation/generation,
ne potlačení nativního TTL nebo důkaz bezpečné obnovy. Startup replay a
každé porovnání skutečné DB vazby platí stále. Jízda `shadow_only`, intake,
OpenAI volání ani ostatní funkční příznaky se nemění.

Aktivace mazání není výsledkem tohoto installeru. Vyžaduje společnou kontrolu
nových služeb/COP, skutečný publication inventory (včetně souborových
reportů), restore postupu, ostatních ownerů a syntetický průchod bez
testovacího mazání reálného účtu. Uživatel nedostává nový Root framework.

### Veřejná CA: nezávisle ověřený instalační předpoklad

15.10.2026 byl přes existující COP read-only mount proveden pouze PostgreSQL
SSLRequest + TLS handshake, bez přihlášení a SQL: `haproxy.home.cz:5000`,
`authorized=true`, TLS1.3, peer CN `haproxy.home.cz`. Schválený veřejný PEM
má byte SHA256
`7a3f9d9373cd63361148230e6c2804c6fb76dc204e18d5039aad7c7838d7a14a`;
ten patří do `postgresCaSha256`. X509 DER fingerprint je odlišná veličina:
`51:D3:BA:59:D8:49:7B:3C:1D:F9:90:E0:6A:9E:B2:07:0C:F2:8F:A7:7B:F0:9B:5E:8C:15:E0:41:DA:C6:FB:84`.
Systémový trust bundle ani jiná AD CA původně tento řetězec neověřily;
žádný TOFU ani vypnutí ověřování nebylo použito. Tento test není produkční
administrátorské přihlášení ani aplikovaná migrace.

Driver env checkpoint je přesný přijatý UUID; SQL002 používá jeho stávající
HMAC. AI checkpoint/generation odpovídají guard vazbě. Oba erasure flags
při přípravě false; příjem Jízdy a `shadow_only` se nemění. Pokud již byl
instalován Root guarded SQL s jinými právy, samotný env přepínač nestačí.

## Skutečné ověření

### Společná syntetická fixture COP–SIM (16. 10. 2026)

`scripts/fixtures/whole-erasure-sim-fixture.py` a jeho připnutý MJS bootstrap
slouží pouze pro společný test dvou syntetických účtů. Nejde o produkční
instalátor ani důkaz dokončené akceptace. Použijí již sestavené neměnné
obrazy Driver/Router a jejich skutečné HTTP factories, PostgreSQL role,
migrace, replay a readback; nekladný stav nenahrazují testovacím callbackem.

- Všechny kontejnery sdílejí výhradně přesně ověřený testovací PostgreSQL
  namespace s `network=none`. Nemají veřejné porty, host bindy ani Docker
  socket; root filesystem zůstává read-only, pracovní soubory jsou v tmpfs.
  Helper nesmí měnit produkční konfiguraci nebo přidávat síťový přístup.
- `--profile negative-v1` (výchozí) zachovává původní negativní případ.
  Nový `--profile full-v2` je oddělený pevně povolený holder
  `cop-messaging-joint-7fb1c640a2de-pg`; nepřebírá původní operaci ani data.
  Žádný profil nepřijímá libovolný holder nebo soukromý zdroj. Nový vstup
  musí odpovídat předem schválenému SHA-256, UID 1000 a režimu 0600.
  Helper jej pouze čte z již schváleného testovacího carrieru; nepřenáší
  soubor z Macu. Historická opravná akce není pro nový profil povolena.
- Soukromý vstup `cop-sim-whole-erasure-fixture-v1` dodá koordinátor COP.
  Obsahuje skutečně testovacím Keycloakem vydané subjecty, původní COP
  router aliasy, úplný denní manifest a výhradně testovací secrets.
  Jiné identifikační namespace ani náhradní HMAC helper SIM nevytváří.
  Každý účet vyžaduje 9–40 unikátních denních položek z helperu COP,
  nikoli jen aktuální den. Veřejný REST limit 40 se tím nemění.
- Přenos vstupu vyžaduje výslovné schválení konkrétního zdroje a cíle.
  Soubor má 0600, obsah se nevypisuje a po testu musí být odstraněn
  včetně dočasných kopií. Zamítnutí není důvodem použít jiný přenosový kanál.
- `serve` nejprve ověří holder, identitu obrazu, zdrojové SQL piny a vstup.
  Existující databázi/roli nenaslepo nepřebírá. Příjem měření a externí
  modely zůstávají vypnuté; testovací mazání je povolené jen v této fixture.
  Driver používá loopback 4311 a Router 4312 pouze uvnitř testovacího
  namespace. Toto nejsou produkční endpointy ani nové veřejné porty.
- `read` uloží neveřejný readback s počty odstranitelných řádků A/B,
  fingerprintem skutečných zachovaných řádků B a samostatnou kontrolou
  SIM namespace. Cesta k souboru není dokladem úspěchu; výsledek musí
  zkontrolovat skutečný nadřazený COP průchod.
- `restart-driver`/`restart-router` znovu použijí původní přijatý enrollment,
  nikoli hodnoty převzaté z obnoveného checkpointu. `cleanup` odstraňuje
  pouze vlastní tři servisní kontejnery; sdílený holder a databáze zachová.

Nový izolovaný běh `full-v2` má připravené obě SIM služby a 29 skutečných
HTTP kontrol; přesné neměnné obrazy a rozsah důkazu obsahuje
[`2026-10-16_SIM_FULL_V2_COMPONENT_READY.json`](../archive/2026-10-16_SIM_FULL_V2_COMPONENT_READY.json).
Jde pouze o připravenost komponent. Společné mazání, restart a obnova ze
zálohy tím nejsou akceptované a produkční aktivace zůstává odděleným krokem.
  Jejich závěrečný úklid vlastní koordinátor celého testu.

Pozitivní společná akceptace vyžaduje skutečný COP controller, oba SIM
ownery a všechny ostatní zapojené komponenty. A musí mít odstranitelný
rozsah nulový, B a SIM/IZS musí zůstat zachované. HTTP 202, capability,
zdravý kontejner, komponentové testy ani `wholeCopAccepted=false` nejsou
dokladem dokončení celého účtu. Obnova s čekajícím důkazem smí prokázat
bezpečnou karanténu; nesmí být označena za dokončené mazání.

### Konkrétní disabled-only vstup připravený 15.10.2026

`scripts/install-sim-erasure-disabled.sh --apply` skládá již existující
provisioner a dva přesně omezené runtime kroky. Nezavádí další Root
autorizační protokol. Vyžaduje jediný skrytý terminálový prompt PostgreSQL
administrátora; žádné třetí JSON s tajemstvím člověk nevytváří.

Přijatý skutečný readonly výstup je uložen v
`deploy/account-safety/20261015-root-inventory.json`: digest
`12e5f824e2aa9f8f740cc4fded7589743902243c0ba641c943b14ab4054ec705`,
0 report souborů / 0 bytes, žádný aktivní producent, jediný cron match
`ecfbe4cdf043c72d8e8704cc624442615f8aaebee995e05e0832ec8eb0e3a0f1`.
Tento výstup není post-stop enrollment. Wrapper před změnou porovná živý
inventář, zdroje, PostgreSQL administrátorský přístup a oba kandidátní
obrazy. Při driftu se zastaví před zastavením služeb.

Produkční runtime zdroj zůstává
`ca1fd6b6046745e91cca6648e1e5bd3f93fc8422`; skutečně sestavené obrazy:

| Služba | Neměnný image ID |
| --- | --- |
| situation-data-api | `sha256:ff8e60608936d4c97cba01e8d96ad064ce3950c6e2a9a115df88dd75fb8fb23d` |
| ai-router-api | `sha256:d4176d79106315d8fe8df1649c7755d1bc2b5189f390fca796a4dbd23778cd2e` |

Host příprava a runtime revize jsou odlišné: nový commit balí jen konkrétní
instalační postup kolem těchto již připnutých runtime bytů. Starý readonly
stage se nepřepisuje a dirty `/srv/sim` se nepulluje/nečistí.

COP `apps/cop-api/src/server.ts` používá přesné pole
`COP_SIM_ERASURE_ACTOR_SECRET` pro oba SIM erasure adaptéry. Proto se
**zachová existující `AI_ROUTER_COP_ACTOR_SECRET`** a stejná hodnota se
doplní jen do chybějícího Driver actor pole a chybějícího COP signer pole.
Přítomná odlišná hodnota či odlišný issuer znamená odmítnutí; žádná tichá
rotace. Hodnoty se čtou výhradně z `/srv/sim/.env` a `/srv/cop/.env`,
přecházejí pouze pamětí a atomickým mode600 zápisem zpět do těchto souborů.
Všechny namespace/hash/encryption klíče, bearery, ostatní nastavení a
vlastník souborů se zachovají. COP služba se tímto wrapperem nerestartuje.
Pád mezi oběma zápisy lze opakovat se stejným zachovaným klíčem.

Po zastavení pouze SDA/Routeru se odstraní jen aktivní řádek s již
schváleným SHA256 `c46a03b13ee8d39860fb7bd72df740006f8762fd421ded44e1b2cac990d15d78`.
Ostatní řádky a ostatní cron/systemd soubory se kontrolují a zachovají.
Řádek se nekomentuje, protože inventura právem vidí i obsah komentářů.
Nový skutečný inventář musí mít 0 souborů, 0 bytes, žádný match, žádného
aktivního producenta a žádný mutex. Starý i nový digest se uloží do
Root-only `/srv/sim/.sim-erasure-cutover/inventory-transition.json`.
Teprve nový digest je podkladem `reportPublication` pro původní provisioner.

UUID bindingy a skutečné konfigurační fingerprinty se vytvoří jednou a
uloží mode600 pod stejnou Root-only složku. Konfigurační review potvrzuje
zachování nasazených identity tajemství a schválený konfigurační rozsah;
není důkazem dokončené COP uživatelské akceptace nebo všech ownerů.
Opakování drží původní enrollment, role/passwordy i namespace. Současný
druhý běh blokuje lokální `flock`. Pád po odstranění cron řádku dohledá
uložený přesný stop-transition intent; jiná konfigurace se nepřijme.
Před každým opakováním se navíc znovu čtou obě produkční secrets a skutečné
identity fingerprinty se porovnají s původním enrollmentem ještě před stop.
Chybějící či změněný signer/issuer nebo namespace znamená konec bez rotace.

Start i `--rollback-disabled` používají pouze oba kompatibilní obrazy a
literal false overlay. Po pokusu o migraci není automatický návrat starého
writeru. Při neúspěšném startu/kontrole se zastaví jen již spuštěné nové
SIM kontejnery; journal ani přijaté fences se nevracejí. Ověření
`--verify` nic nerestartuje. Oba capability endpointy musí vrátit
`enabled=false`, `ready=false`, všechny strukturální checks true a
`wholeAccountComplete=false`; kontrolují se i skutečné sítě, aliases,
porty, zachované mounty a read-only CA. Pokud nové služby ještě neběží,
není příprava ani lokální test vydávána za tento produkční výsledek.

Testy nového vstupu:
`node --test scripts/test-stage-sim-erasure-identity.mjs scripts/test-sim-erasure-runtime-step.mjs scripts/test-install-sim-erasure-disabled.mjs scripts/test-sim-root-inventory.mjs`.
Jde o syntetické souborové/pure kontroly včetně částečného zápisu secrets a
opakování po cron retirement, ne simulované potvrzení skutečného sudo
nebo celé produkční sekvence. Původní skutečná PostgreSQL/restore sada se
spouští zvlášť; její historické receipts se nepřepisují.

Před lidským Root spuštěním ověřit externě oznámený hash shell vstupu a
manifest jeho úplných zdrojových závislostí. Manifest neobsahuje secrets.
Příprava/nahrání ani non-root `--plan` neprovádějí migraci, zastavení,
cron editaci nebo aktivaci mazání. Produkční výsledek se dokládá až
skutečným výstupem lidského běhu.

Přípravný installer prošel 15.10.2026 **13/13** izolovanými kontrolami se
skutečným PostgreSQL18, omezenými SCRAM účty a produkčními factories.
Regrese: 873 PASS, 6 volitelných PG SKIP, typecheck/build/skeleton/OpenAPI
151 cest / 274 schémat PASS. Test Compose navíc porovnal výsledné služby,
sítě, porty a mounty; nic nebylo spuštěno. Přesné SHA a omezení důkazu jsou v
[kurátorovaném instalačním souhrnu](../archive/2026-10-15_SIM_ERASURE_INSTALLER_ACCEPTANCE.json).
Root CLI a produkční zastavení writerů zůstávají součástí skutečné údržby,
nikoli tvrzením lokálního testu. Místní fixture byla zastavena a odstraněna.

Navazující aktuální sada má **23/23 PASS**: skutečný atomic file export,
PG blokování potvrzené `pg_blocking_pids`, ukončení publisher backendu,
odmítnutí ACK během drženého filesystem mutexu, startup odmítnutí zbylého mutexu, chybný actor/symlink,
cron fixture, reálné `pg_dump`/`pg_restore` obou target DB a starého reportu.
Guard DB se neobnovovala se snapshotem. Karanténa zabránila factory startu;
po výslovné syntetické nové incarnation/checkpoint/generation2 skutečné
factories s aktuálními fingerprinty odstranily A, zachovaly B i SIM klíč
a invalidovaly historický report před expozicí. Skutečná retence/revoke
byla ověřena samostatně po kontrole zachování B. Hash secrets se nerotovaly:
to by rozbilo namespace historického replay. Tato sada není fyzickou
obnovou PBS, produkčním Root inventářem ani akceptací všech ownerů COP.
Aktuální SHA, pozorované výsledky a omezení jsou v
[samostatném report/restore souhrnu](../archive/2026-10-15_SIM_REPORT_RESTORE_ACCEPTANCE.json);
starší 13-case ani společný HTTP artefakt se nepřepisují.

## Report mutex a přesný postup obnovy

Reporty jsou pouze obnovitelná cache. `writeFileReport` zapisuje jen
`quality.json`/`aggregates.json`, soukromě a atomicky s fsync, pod skutečným
PG shared lockem i lokálním atomickým `.publication-lock` adresářem.
ERASE, ACK, retence, revoke a startup invalidace používají exkluzivní
protějšek a skutečně mažou celý odvozený cache, nikoli jiná aplikační data.
ACK ověřuje původní operation/actor/request v nezávislém journalu a target
zero readback; samotný callback nemůže smazání potvrdit.

Ztráta PG spojení nesmí odstranit filesystem interlock běžícího exportéru.
Po pádu procesu zbylý mutex **nemá automatické převzetí ani TTL**. Odmítnout
novou publikaci/mazací ACK, zastavit přesné SDA producenty, prokázat jejich
ukončení a až ve stejné schválené údržbě odstranit prázdný vlastní mutex
uvnitř tohoto jediného adresáře. Nikdy nesmazat neznámý/neprázdný mutex,
symlink nebo obejít odmítnutí změnou publication/no_report. Runtime nemusí
mít obecné Root oprávnění; má jen tento soukromý mount.

Při obnově nejprve zastavit target writery a expozici, dát nezávislé guard
bindingy do quarantine a obnovit pouze target DB. Starý marker/env není
nový enrollment. Správce ověří souvislý nejnovější nezávislý journal,
explicitně přijme novou incarnation/checkpoint/generation v guard i target
markeru, přesný Driver checkpoint HMAC a Router checkpoint; zachová skutečné
identity/hash secrets. Guard backup se nesmí přetočit na starou app kopii.
Potom izolovaně spustit skutečné factories: Driver před listen přehraje
fences a odstraní obnovené reporty; Router replayne fences/klíč a před listen
vypořádá způsobilé pending primary řádky. Nejisté provider rezervace zůstávají
pending a účet je fenced, nikoli obnovený do provozu. Bez zero/B/SIM readbacku
a kontroly report adresáře se expozice nevrací. Původní first-install skript
záměrně odmítne automatické reenrollment obnoveného starého bindingu.

Loadery před listen replaynou všechny vlastní tombstones do skutečných
target fences. Journal COMMIT předchází target změně; nejistota se řeší
lookupem stejného operation ID, ne novou operací. Žádný true callback.

`scripts/test-database-erasure-http.mts --run <port>` přijímá jen vlastněný
lokální cluster `cop_erasure_owned_test` a odmítne přepsat existující DB.
`--serve-existing <port>` ověří fixture fingerprint a spustí skutečné HTTP
služby pro COP test; private JSON má mode600 a pouze syntetické údaje.
Ověřit celý COP controller → HTTP → PG, auth/invalid/limit/outage, idempotenci,
batch/delete race, ETA cizího parentu, 202→settlement→200, B/SIM preservation
a restart/replay. Jiný chybějící povinný owner ponechá celý COP účet pending.

## Před produkcí a návratem

HTTP reporty drží skutečný sdílený PG zámek do ukončení odpovědi; delete
a barrier mají exkluzivní protějšek. Externí souborové exportery/cache
nutno inventarizovat a zastavit/invalidovat nebo zapojit do téže ochrany.
HTTP ochrana neprokazuje bezpečnost cizího writeru; nelze tvrdit `no_report`.

Před obnovou zastavit služby i expozici. Guard neobnovovat se starým app
snapshotem; přijmout novou incarnation/generation, izolovaně replaynout,
ověřit a teprve poté zpřístupnit. Při obnově celého clusteru obnovit nejnovější
nezávislý guard backup/WAL bez mezer; nejistota znamená karanténu. Starý
image bez replay se nevrací. Lokální test není fyzická obnova PBS.

Návrat zakáže nové operace, nikoli přijaté fences/retry/replay. Nemazat
journal ani nevytvářet prázdný namespace. Produkční secrets, granty a
obrazy se mění až po společné akceptaci, bez změny veřejných portů/sítě.
