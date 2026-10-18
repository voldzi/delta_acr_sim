# 21 — Clean COP/SIM reset: omezený operační zdroj

Stav 17. 10. 2026: zdroj a izolované syntetické testy, nikoliv provedený reset
nebo společná produkční akceptace. Původní CF24, soubor, otisky a operace se
nemění ani nepřebírají. Navazuje na [kontrakt 24](../integration/24_CLEAN_LIFECYCLE_SOURCE_CANDIDATE.md)
a [ADR 0043](../adr/0043_ATOMIC_KNOWN_GUARD_RESET.md).

## Vstup a autorita

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
