# DBv2: akceptace mazání COP/Jízdy

Aktivní zdrojová cesta je [ADR0040](../adr/0040_DATABASE_BACKED_ACCOUNT_ERASURE.md).
Produkční aktivace není doložená. Root/native instalace není její podmínkou.
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
   release konfigurace. Síť, veřejné porty, ostatní služby a X5 mounty neměnit.
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
   pouze read-only public CA mount na `/etc/csm-sim/postgresql-ca.pem`
   (`create_host_path=false`). Target i guard TCP mají explicitní
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

```sh
SIM_ERASURE_PG_ROOT_CERT_FILE=/etc/vcode-cop-pgbouncer/postgres-ca.crt \
  bash /path/to/pinned-sim-release/scripts/provision-sim-erasure-production.sh --check
SIM_ERASURE_PG_ROOT_CERT_FILE=/etc/vcode-cop-pgbouncer/postgres-ca.crt \
  bash /path/to/pinned-sim-release/scripts/provision-sim-erasure-production.sh \
  --apply --enrollment /root/sim-erasure-reviewed-enrollment.json
```

Instalace drží **oba erasure enabled flags=false**. Inicializuje pouze
výslovně přijatou binding/replay konfiguraci; Driver publication zůstává
`false` a report protection `unverified`, nikoli smyšlené `no_report`.
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

Přípravný installer prošel 15.10.2026 **13/13** izolovanými kontrolami se
skutečným PostgreSQL18, omezenými SCRAM účty a produkčními factories.
Regrese: 873 PASS, 6 volitelných PG SKIP, typecheck/build/skeleton/OpenAPI
151 cest / 274 schémat PASS. Test Compose navíc porovnal výsledné služby,
sítě, porty a mounty; nic nebylo spuštěno. Přesné SHA a omezení důkazu jsou v
[kurátorovaném instalačním souhrnu](../archive/2026-10-15_SIM_ERASURE_INSTALLER_ACCEPTANCE.json).
Root CLI a produkční zastavení writerů zůstávají součástí skutečné údržby,
nikoli tvrzením lokálního testu. Místní fixture byla zastavena a odstraněna.

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
