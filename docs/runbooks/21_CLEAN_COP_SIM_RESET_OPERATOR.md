# 21 — Clean COP/SIM reset: omezený operační zdroj

Stav 17. 10. 2026: zdroj a izolované syntetické testy, nikoliv provedený reset
nebo společná produkční akceptace. Původní CF24, soubor, otisky a operace se
nemění ani nepřebírají. Navazuje na [kontrakt 24](../integration/24_CLEAN_LIFECYCLE_SOURCE_CANDIDATE.md)
a [ADR 0043](../adr/0043_ATOMIC_KNOWN_GUARD_RESET.md).

## Vstup a autorita

### V8: dokončení částečně připraveného pracovníka bez rotace

Po běhu V7 jsou obě pole uložena, klient i čtyři přiřazené role existují,
ale dedikovaný client scope dosud neměl role. Čtecí kontrola COP to spojila
se zdrojovou chybou transportu: Keycloak po POST role-mapping vrací úspěšné
HTTP 204 bez těla, původní `boundedJson()` však vždy vyžadoval reader.
Nešlo o neúspěšné přihlášení administrátora. Není dovoleno pokládat pouhou
přítomnost obou polí za dokončené zřízení.

Nový veřejný helper s SHA-256
`48db373f5d8cff560ae9365dd8f4ea569677342dc31ca2cc917e463394d5e045`
akceptuje pouze status 204 s přesně nulovým tělem; pro ostatní odpovědi
ponechává omezený JSON decoder a všechny provider/role/scope kontroly.
Nevzniká obecná výjimka pro chybějící tělo HTTP 200.

Přepínač `--reconcile-keycloak-worker` je dovolen jen s
`--resume-public-v6`. Vyžaduje již existující obě jednoznačná pole, přesné
ID a platný tvar uloženého secretu a samostatné potvrzení
`RECONCILE_EXISTING_KEYCLOAK_WORKER`. Znovu provede původní schválený helper
se stejným uloženým secretem, který se porovná s poskytovatelem ještě před
změnami mapování. Doplní pouze chybějící schválená mapování. Neznámý klient,
cizí účel, odlišný secret, nadbytečné role/scope nebo částečná konfigurace
zůstávají chybou; nic se automaticky nemaže ani nerotuje. Bez explicitního
přepínače se tato rekonsiliace automaticky neprovádí.

Zůstává tentýž Root V6 balík, jeho manifest a všechny obrazy. Nepoužívat
žádný `--preserve-*` přepínač. Další testovací sady se nespouštěly; nejde
o tvrzení úspěšného zřízení nebo nasazení. Runtime provider/readback a
databázové kontroly se nadále musí skutečně dokončit před aktivací.

### V7: chybějící příprava Keycloak před databázovou částí

Čtecí diagnostika po V6 doložila chybějící obě pole
`COP_KEYCLOAK_ERASURE_CLIENT_ID` / `COP_KEYCLOAK_ERASURE_CLIENT_SECRET`.
`--complete-release` je dosud pouze předpokládal; sám je nezřizoval.
Moduly i canonical host parser se skutečně načetly správně; k povinnému
PostgreSQL plánu se tento běh nedostal. Neslibovat úspěch dalších kontrol.

Externí launcher V7 používá pouze `--resume-public-v6` s původním manifestem
`e3752ed8…` / zapečetěným COP `3ec5366` a přesným Root control důkazem.
V6 balík se nepřejmenovává ani nepřepisuje a nevzniká nový bootstrap či obraz.
Před PG promptem provede již schválenou přípravu dedikovaného pracovníka,
pouze pokud chybí obě pole. Částečná/odlišná konfigurace znamená stop.
Přítomná pole sama nedokazují připravenost poskytovatele; následující povinná
Keycloak inventura skutečně ověřuje autentizaci a dostupná oprávnění.

Samostatný veřejný helper COP `15a590b`, `install-clean-erasure-client.mjs`,
má SHA-256 `8650fab53fb9c9a05814a25a43b12c8473f1f350924ecccc7b77b57cb3316763`.
Root launcher ověří jeho skutečné bajty a spustí tento buffer, nikoli znovu
otevřenou veřejnou cestu. Pouze úvodní hashbang se vynechá stejně jako při
parsování souboru Node. Zůstává původní schválený worker, přímé čtyři role
a přesně kontrolovaná efektivní sada šesti rolí, nikoli realm-admin.
Přihlašovací údaje administrátora a token zůstávají v RAM serveru, heslo
se zadává skrytě do zděděného TTY. Nic z toho nejde na Mac, do argumentů,
Gitu či výstupů. Helper načítá ověřené původní provision/parser moduly ze
zapečetěného COP `3ec5366`, používá canonical parser dvou již schválených
duplicit a atomicky zachová ostatní bajty i metadata `.env`; mění jen tři
vyjmenovaná pracovní pole a scoped-authority ponechá false. Nerestartuje služby.

Při chybě po uložení worker secretu se nesmí předpokládat úspěšné vytvoření
klienta ani slepě opakovat reset. Je nutná výslovná rekonsiliace stejného
klienta a uloženého secretu, nikoli jeho automatická rotace.
Nová bezpečná diagnostika přípravy uvádí pouze pevnou etapu
`module_import`, `cop_env`, `common_inspection` nebo `cop_manifest`; nevrací
text výjimky ani soukromý vstup. Nadlimitní výstup má samostatný pevný kód.

Nové testovací sady se nespouštějí. PG admin přístup a aktuální počty nových
rolí/databází/guard tabulek nejsou odvozené ze zdroje: ověří je skutečná
read-only příprava s heslem v RAM. Neúspěšné síťové spojení není PASS.
Příkaz mířící na V7 lze předat až po skutečném uploadu a ověření jeho hashů.

### Jediný produkční příkaz po zrušení dalších testovacích kol

Připnutá oprava COP je `3ec5366e4de676cf68fddae50c0df625df39c284`.
Připravovaný veřejný balík V6 je v původním uživatelském stagingu `resume-3`;
nemění již zapečetěný V5 ani jeho manifest. Jeden příkaz používá
`--prepare-peer-access --preserve-public-v5 --complete-release`.
Před vytvořením dočasného přístupu ověří skutečný starý V5 balík `3ef1…`.
Existující/nekonzistentní dočasná autorita se nepřebírá. Přes již schválený
připnutý helper vytvoří klíč pouze do Root RAM a vypíše veřejný JSON.
Operátor jej předá COP a nechá tentýž příkaz čekat. COP instaluje veřejné
omezené oprávnění na oba servery; po potvrzení operátor zadá
`TRANSPORT_READY`. Následně se skutečně ověří SSH/sudo na obou serverech.
Tento text není důkaz přístupu. Heslo PostgreSQL se zadává pouze skrytě do
Root terminálu později; žádné tajemství se nevypisuje ani nepředává v chatu.
Dokončení, chyba i přerušení procházejí stávajícím úklidem obou autorizací,
control spojení a privátního klíče. Neověřený úklid musí být hlášen jako chyba.

Uživatel 18. 10. schválil opravu custody zrušeného cronu a požádal o přípravu
nasazení bez dalších testovacích kol. Nový launcher nepředkládá samostatnou
diagnostickou sondu jako další krok: zavolá nezměněnou připnutou čtecí sondu
uvnitř `--preserve-public-v5`, před změnou veřejného balíku. Vynutí platnou
Root retirement vazbu, skutečné čtení control složky jen se známým důkazem,
nulový počet aktivních producentů i scheduler matches a nepřítomný lock.
Sonda je provozní preflight, ne nová syntetická akceptace. Její report se
nepřeznačuje za dokončené mazání.

Zachovává se přesný existující V5 manifest `3ef1c647…` / COP `4ed81c5` jako
`clean-operator-shared-v3-preserved-v5-4ed81c5`; dříve zachovaný V4 se nemění.
Přechod stále dovolí jen změnu veřejného COP archivu, nikoli výměnu obrazů,
SIM `15d8a75`, Messaging `969a751` či prodloužení platnosti reportu `66b6…`.
Existující plán/enrollment/epocha/neznámý obsah nebo nepřístupná inventura
zastaví postup. `--preserve-public-v4` se po jeho provedení neopakuje.

Po přechodu nový COP profil `known-retired-v1` průběžně kontroluje drženou
vazbu skutečných Root receiptů a schedulerů. Stará legacy větev zůstává
oddělená. Žádné vytvoření markeru nebo vrácení staré úlohy jen kvůli guardu.
Výpadek nebo změna vazby znamená zastavení; nelze zapnout writery jednotlivě
proti částečně změněnému schématu. Přístup na COMM/storage je samostatný
nezbytný autentizační předpoklad, nikoli test; launcher neobchází SSH/sudo.

Příprava příkazu není produkční nasazení. Nové testovací sady nebyly na přání
uživatele spuštěny. Před zveřejněním se provede pouze kontrola syntaxe,
statické návaznosti, rozsahu změny a otisků artefaktů. Skutečné provozní
kontroly zůstávají povinné uvnitř příkazu; uživatel následně ověří funkčnost
v produkci. Platnost původního akceptačního důkazu se nesmí uměle obnovit.

### Diagnostika již odstraněného reportovacího cronu

Původní disabled-only instalátor podle runbooku 20 odstranil přesný legacy
cron `c46a03…`; novější `DriverReportProducerCustody` jej však dosud vyžaduje.
Absence samotného řádku není důkazem absence jiných producentů. Nevytvářet
komentářový marker, neobnovovat starou úlohu a neměnit očekávaný otisk naslepo.

`scripts/inspect-retired-report-profile.py` je samostatná Root **čtecí** kontrola:
ověří veřejný launcher V5, skutečný zapečetěný strom SIM `15d8a75` / COP `4ed81c5`,
Root-only `post-stop-inventory.json`, `inventory-transition.json` a otisk
`runtime-plan.json` v `.sim-erasure-cutover`. Nepřistupuje k `.env`, stavovému
souboru s identitami, SQL ani autorizačním klíčům. Znovu spustí původní
`reportInventory()` z ověřeného SIM zdroje: vybrané systémové/user cron a
systemd soubory, procesy a chráněné reporty. Vypíše pouze předem vyjmenované
otisky, počty a booleany; nevrací obsah cronu, jména reportů či tajemství.
Příkaz musí nést neutrální název souboru, nikoli tělo sondy s klíčovými slovy
producenta v argumentech rodičovského procesu. Zkontroluje také skutečným Root
čtením, že control složka obsahuje jen původní důkaz `66b6…`, žádný plán.

Čtecí sonda se sama nespouští. Její výsledek je podkladem pro další rozhodnutí,
nikoli přijetím nového producer profilu nebo produkční akceptací. Při chybě
končí bez změny cronu, služeb, databází, klíčů a bez uložení nového enrollmentu.
`scripts/test-retired-report-profile.py` ověřuje šest syntetických scénářů.

### Opravený veřejný operační balík V5 (18. 10. 2026)

Zdrojový COP `4ed81c5a5ea0772a8d83636473925f07fe92b389` opravuje
nedefinované `sha` v původní cestě dočasné identity přímým `hashlib.sha256`.
Nejde o nový aplikační obraz ani nový akceptační důkaz. Obrazy, SIM archiv
`15d8a75`, Messaging archiv `969a751` a původní report s SHA-256
`66b6fb13c8a52c3d06f6aecafe3c9b101e5376cda3049988843e9d4961e0e38a`
zůstávají stejné. Čas reportu se neobnovuje; po vypršení je nutné nové skutečné
ověření, nikoli úprava `checkedAt`.

Přepínač `--preserve-public-v4` vyžaduje Root terminál a samostatné potvrzení
`PRESERVE_PUBLIC_V4_AND_REBUILD`. Před změnou ověří původní manifest `4f163f…`,
neměnný strom a soupis zdrojů, původní verze, X5 UUID a alespoň 3 GiB místa,
platnost původní akceptace a všechny nové archivy. Nový manifest smí měnit
výhradně COP archiv. Správce musí přímo přečíst Root složku
`/srv/cop/runtime/clean-reset`: dovolena je pouze původní `whole12-acceptance.json`
s přesným otiskem, Root:Root, 0600, jeden hardlink. Chyba přístupu, plán,
enrollment, epocha nebo jakýkoli jiný obsah znamenají stop před přejmenováním.

Pouze původní veřejný balík `clean-operator-shared-v3` se atomicky a bez možnosti
přepsání cíle zachová jako `clean-operator-shared-v3-preserved-v4-f4f0474`.
Jeho obsah se neupravuje ani nemaže. Následuje nová sestava z ověřených veřejných
archivů; importy nesmějí zapisovat bytecode do chráněných stromů. Existující
archiv, konflikt, změna souboru nebo částečná chyba vyžadují ruční kontrolu;
žádná automatická adopce, obnova ani odstranění rozpracovaného stavu.
Soubory databází, aplikací a secrets tento přechod nemění.

Příkaz pouze připravíme a zveřejníme; sám se nespouští. Případné následné
`--complete-release` stále vyžaduje původní interaktivní potvrzení rozsahu,
heslo PostgreSQL jen v RAM a závěrečné potvrzení před změnou dat.
Změna veřejného balíku není důkazem nasazení či dokončeného mazání.

Regrese: `test-public-v4-transition.py` (včetně skutečného atomického rename
na syntetických složkách), `test-release-control-prerequisites.py`,
`test-prepare-and-seal-clean-release.py` (celý `main` po hesle přes náhradní
externí adaptéry až po zachycení stavu, reset, aktivaci a úklid),
`test-bootstrap-clean-release-root.py`, `test-complete-clean-release.py` a
`test-coordinate-clean-release.py`. Tyto testy neprovádějí produkční nasazení.
Chyby vypisují pouze pevný kód nebo identifikátor chybějícího Python jména,
nikoli text výjimky, hesla či obsah podkladů.

`node scripts/plan-clean-sim-reset.mjs --plan` pouze vypíše konečný rozsah.
Nemá `--apply`, nečte přístupové údaje a nepřipojuje se k serveru. Moduly
`scripts/lib/clean-reset-*.mjs` nejsou endpoint ani součást runtime obrazu.
Skutečnou Root autoritu tento zdroj neposkytuje. Společný řadič musí dodat
a držet skutečnou maintenance/admission hranici, ověřit schválené neměnné
obrazy, zastavení obou writerů a producentů reportů a nezávislý deník,
same-epoch obnovu a replay. Testovací port tento důkaz nenahrazuje.

Operátor porovná čtecí plán a jeho digest. Změna dat před získáním zámku
vyžaduje nový plán a schválení. Pevný manifest
`deploy/clean-lifecycle/reset-manifest-v1.json` má SHA-256
`de4548fad17c1bc978d91951f59ec5bd8648b2711f5d168f517efe332aedd09d`.
Obsahuje otisky migrací a katalogu nezávisle sestaveného ze zdroje
`6238345b8e50a67441043b2e732e1516254f5f27`; živý katalog se automaticky nepřijímá.

## Konečný databázový rozsah

| Databáze                  | Mazané položky                                                                                                                                               | Zachované položky                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `sim_ai_router`           | `ai_router_request WHERE client_id='cop'`; všechny `ai_router_user_key` a `ai_router_user_key_audit`; `ai_router_billing_request WHERE task_type='cop_chat'` | jiné request/billing lanes; policy, policy audit, erasure checkpoint, erased daily costs |
| `sim_driver_measurements` | `driver_measurement_eta`, `driver_measurement_intervals`, `driver_measurement_receipts`, `driver_measurement_revocations`                                    | `driver_account_erasure_state`, pevné ETA/contributor vazby                              |

AI legacy `ai_router_account_erasure`, driver legacy
`driver_account_erasure_operations` a `driver_account_erasure_revocations`
musí být prázdné. Existuje-li `sim_erasure_guard_v2.tombstone`, musí být také
prázdná. Nenulový stav se nemaže ani nereinterpretuje: operace skončí.
COP billing mimo `user_openai_key` nebo s neshodným actor/payer rovněž blokuje.
Neznámá FK závislost, guard, RLS pravidlo nebo role znamenají stop.

Přesný starý katalog AI:
`1a6fa3e8a462391c736d0b60e3e3153556161b26063b947a36d70b1739041d9c`;
driver: `5b4e0fadf019e8d4818dd761f240ba5b011da4847fde002088c76b06cfe358b2`.
Čtecí kontrola živého PG 18.6 souhlasila: 20 COP a 3 jiné AI requesty,
policy 1 a policy audit 6. Nejde o budoucí předpoklad: operační plán znovu
ověří počty a zachovávané serverové digests, bez výpisu uživatelských hodnot.

## Atomický přechod v každé DB

Použije se vlastník migrací, ne širší runtime oprávnění. Před i po práci se
obnoví PG statistický snapshot a ověří absence jiných runtime i owner spojení.
Konečné tabulky se zamknou `ACCESS EXCLUSIVE`, s omezeným lock/statement timeoutem.

V jedné transakci se ověří katalog a data, smaže konečný rozsah, nahradí přesně
známé staré COP guards novými a provede nový explicitní production enrollment.
AI pořadí migrací: `001,002,007,005,003`; driver: `001,008,006,004`
z `deploy/clean-lifecycle/`. `007/008` nejsou obecná výjimka: běží až po shodě
celého katalogu a ve stejné transakci jako nové fences. Chybějící starý guard
není úspěch. Zachovávaná data musí mít stejné počty a digests. Před COMMIT se
znovu ověří živá autorita a absence DB writerů.

Povoleno je jen známý starý → známý nový stav nebo opakování již nového,
dosud nepoužitého stavu se shodným enrollmentem. Nová uživatelská data blokují retry.

## Soubory na X5

`/srv/x5-production` musí být samostatný mount s UUID
`2f93f595-b61b-4eea-9054-7afa9b275b5b`, jiným zařízením než `/` a alespoň
100 MiB volného místa; kontrola před každým odstraněním.

- `cache/csm-sim/driver-measurement-reports`: pouze `aggregates.json`,
  `quality.json` a `.report-tmp-<UUID>`; producent musí být skutečně zastavený.
  Prázdný adresář či absence publication locku tento důkaz nenahrazuje.
- `data/csm-sim/situation-data/geo-routing-v1/precomputed`: jen validní
  `<64 lowercase hex>.json` s přesným `actor='cop'`. Ostatní validní actory
  zachovat beze změny. Čtecí inventura našla 1 COP a 911 jiných souborů.

Symlink, hardlink, neznámý/neplatný soubor, publication lock nebo změna
inventura→mazání blokuje. Výstup obsahuje jen součty a otisky. Zachovat SIM
store, scénáře, drafts, fronty, zdroje, konfiguraci, secrets, Valhallu,
traffic/DEM/radar/safety/flight cache a TAK.

## Částečný neúspěch a návrat

Nejde o distribuovanou transakci dvou DB a souborů. Při částečném neúspěchu
Root drží oba writery i producenty zastavené. Nelze spustit jednu službu po
úspěchu její DB. SQL chyba vrací celou vlastní transakci včetně guardů.
Reprodukovatelné souborové cache se neobnovují. Podle výslovného rozhodnutí
uživatele nevznikají zálohy testovacích uživatelských dat. Zachovají se kód,
konfigurace a secrets. Starý kód nesmí běžet proti novému schématu bez
ověřené kompatibility; při nejistotě zůstane služba zastavená.

## Ověření a otevřené gates

`node scripts/test-clean-reset-files.mjs`: 13 izolovaných kontrol,
produkční soubory nezměněny. `node scripts/test-clean-reset-postgres.mjs --run`:
87 kontrol nad vlastními PG 18.3 DB bez síťového listeneru, skutečný restart,
rollback při návratu writeru/ztrátě admission, odmítnutí změněného guardu,
zachování jiných lanes a běžné handlery po skutečné výměně RLS/guardů.
AI model je syntetický lokální fixture, externí volání 0; driver `shadow_only`.

Závěrečná regrese pod Node 24.21.0 / pnpm 10.33.0: `pnpm typecheck`,
`pnpm build`, `pnpm test` (873 prošlo, 6 přeskočeno), skeleton validace,
OpenAPI validace (157 cest, 277 schémat) a formát nových souborů prošly.
Veřejný ani interní HTTP kontrakt se tímto operačním zdrojem nemění.

Nejde o akceptaci skutečné Root autority ani celého COP–SIM. Před aktivací
musí společný řadič ověřit skutečný freeze, nezávislý journal/restore/replay,
schválené obrazy, obě DB i soubory, běžné HTTP flows a ochranu proti návratu
smazaných dat. Výstup SIM nikdy netvrdí `wholeAccountComplete=true`.


## Exact publisher compatibility transition from sealed V6

The production publisher queue legitimately contains optional `lastSuccessAt`
and `lastFailureAt` fields. A read-only projection confirmed the exact four-key
shape and canonical UTC timestamps. The former finite-reset scanner accepted
only the two-key empty baseline and therefore could not inspect this valid
production file. Source `08d81c3` accepts only the two documented optional times
and removes them along with the cleared test queue. Unknown fields remain an
error. The shared scanner is used by both inspection and reset; the original
raw-byte plan digest, compare-and-swap and writer-admission controls remain.

The external `--preserve-public-v6` transition changes exactly the COP and SIM
source archives: COP `6c01ef7` pins that specific SIM revision in its retired
producer custody inspector, SIM `08d81c3` supplies the publisher compatibility
scanner. App images, messaging source, storage provider and the previously
accepted whole-provider proof are unchanged. Root must find only that proof in
the control directory and verify the old V6 sources before creating temporary
peer access; it preserves the exact old immutable bundle with no replacement.
It never adopts a reset plan or refreshes the age of the acceptance proof.

If Node preparation fails, diagnostic output contains only fixed stages,
component labels, standard SQLSTATE codes from an explicit list and literal
known guard identifiers. Error messages, stack traces, SQL and private inputs
are never emitted. No additional test suite was run by operator instruction.
The ordinary runtime connection verified both COP empty-only tables are empty
and that new SIM roles and database are absent; it cannot connect to the guard
database. Those guard relations and administrator authentication remain for the
actual Root read-only preparation, and are not claimed as verified.


## Exact COP Keycloak inventory transition from sealed V9

A server-side, read-only check using the configured worker returned HTTP 200
for all requests, 12 clients, three independently verified service accounts and
one closed page of 11 ordinary users. None of the service IDs appeared in the
ordinary list. The old reset incorrectly required those lists to overlap.
COP `f3a701a` merges the authoritative inventories, binds each service to its
client UUID/public client ID/creation time, and excludes services from human
mutations. Duplicates, conflicting overlaps and unknown service markers remain
errors. No administrator may edit realm users or clients during reset; separate
provider GET/write operations are not an atomic CAS.

The external `--preserve-public-v9` transition preserves the exact previous
immutable V9 bundle and changes only the COP source archive. SIM `08d81c3`,
messaging, all nine candidate images, storage provider and acceptance proof
remain unchanged. Root verifies V9 custody and absence of a pending operation
before temporary access; it builds a fresh plan rather than adopting one.
The existing fixture source now models ordinary users without service accounts;
no test suite was executed under the operator's cancellation.

## Explicit finite report-age exception for this one release

On 2026-10-18 the operator explicitly approved using the original report bytes
with SHA-256 `66b6fb13c8a52c3d06f6aecafe3c9b101e5376cda3049988843e9d4961e0e38a`
and the same nine candidate image IDs until **2026-10-19 15:22:00 UTC**
(17:22 CEST). The original `checkedAt=2026-10-17T15:22:13Z` is unchanged. This
is not a new acceptance result, a generic 48-hour mode or permission to skip
other provider, database, writer, source, identity or activation checks.

COP `d089c91` owns `validate_clean_whole_report_bytes(raw, images, actualNow)`.
It hashes the original bytes itself, requires the exact approved v3 report,
stamp, image set and absolute deadline, and continues all structural checks.
Ordinary dictionary validators retain their 24-hour policy. No environment
variable, caller-supplied approval boolean or fabricated clock enables it.

The first preserve gate still runs before replacing the old immutable bundle.
For this explicit V9 transition only, the external launcher verifies the exact
new COP tar hash, selects one fixed regular acceptance-module member, verifies
its source hash and compiles those bytes in RAM. It passes the actual protected
Root report bytes and real clock to the new bytes validator; it does not edit
or monkeypatch the old bundle. The same check runs before temporary peer-key
preparation. Publication and all later Root/reset/activation gates use the new
sealed bytes validator, including repeated checks during activation.

Only the COP source archive changes. SIM `08d81c3`, messaging, candidate images,
storage provider and original report bytes remain unchanged. The exact old V9
bundle is preserved without replacement; Root must start with only that proof
in the control directory, publish a new plan exclusively and retain its lock.
No previous operation or plan is adopted. These existing Root custody gates
limit the approved path to this one release operation. The one-hour health
baseline and independent temporary-key expiry remain unchanged. Finishing
after the exception deadline is not allowed, even if installation began earlier.
No additional test suite was run by instruction; the operator will verify the
application after deployment. Source checks do not assert production activation.
