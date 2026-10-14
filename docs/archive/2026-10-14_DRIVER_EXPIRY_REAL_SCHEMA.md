# Ověření pevné expirace nad skutečným schématem SIM

Místní PostgreSQL 18.3 ověření dne 14. 10. 2026 prošlo **11/11 případů**.
Jde o samostatný source kandidát expirace, bez produkční migrace, nativního
napojení nebo změny skutečných dat. Běh 15:28:13–15:28:15 UTC používal
nezměněné skutečné driver tabulky, FK a guard z `schema.sql` a migrace `002`.
Přesné případy a piny obsahuje
[strojový záznam](2026-10-14_DRIVER_EXPIRY_REAL_SCHEMA.json).

## Zdroj a testovací prostředí

| Vstup | SHA-256 |
| --- | --- |
| `scripts/fixtures/driver-retention-real-schema/expiry-source.sql` | `1561825849c8990526af26eae3866ee2100072db72bed638997a2eec7a8afb7a` |
| `scripts/test-driver-expiry-real-schema.mts` | `61ff2bfe5b3510fa0c8d4a2be61bc8cea83fb798695d35713b0681634f5e2b6f` |
| `deploy/driver-measurements/schema.sql` | `6dd60a3acf28d63575198c8526c368df19bbd543f4063d4985fb55f308da02d0` |
| `deploy/driver-measurements/002_account_erasure.sql` | `f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad` |
| Strojový záznam | `8dac0d99b4add01446b05e8fdc6cd752f5d754328754fc46fe5848b954841396` |

Test vytvořil nový cluster v soukromém dočasném adresáři a poslouchal pouze
na Unix socketu s oprávněními 0700. Nepřijímá cílovou URL, produkční heslo nebo
externí databázi. Přístupy a data byly syntetické; controller vlastnil původní
i kontrolní spojení. Po úspěchu zastavil a odstranil pouze svůj cluster.
Nebyl otevřen TCP port, použit Docker, změněna síť nebo voláno OpenAI či jiný
provider. Node 24.16.0; přísná samostatná TypeScript kontrola prošla.
Before/after kontrola `sourceUnchangedDuringRun` pokrývá tři SQL vstupy.
Hash harnessu je zachycený při dokončení, nikoli jako samostatná before/after
attestace jeho souboru. Čtecí peer revize připnutého SQL, harnessu a záznamu
nenašla P1/P2 ve vymezeném místním rozsahu; nepředstavuje druhý běh testů.

Skeleton, samostatný přísný TypeScript check, OpenAPI sanity (151 cest,
273 schémat) a `git diff --check` prošly. HTTP kontrakt i aplikační zdroje
se touto změnou nemění; dřívější workspace regresi z lifecycle záznamu
nepřičítáme k novým jedenácti případům. Reindex Chroma skončil na odmítnutí
náhradní repository identity; index ani jeho bezpečnostní hranice se neobchází.

První přípravný běh skončil před testy kvůli chybějícímu přetypování
`tgenabled` v kontrolním snapshot dotazu. Druhý zastavil první případ,
protože nekvalifikovaný název tabulky při nepřístupném `public` schématu
vrátil 42P01 místo očekávaného 42501. Opraveny byly pouze kontrolní dotazy
harnessu; SQL source kandidát zůstal stejný. Oba vlastní servery byly zastavené
a soukromé syntetické pozůstatky po kontrole odstraněné. Úspěšných 11 případů
patří pouze závěrečné připnuté verzi, nikoli dřívějším pokusům.

## Ověřené databázové vlastnosti

- Runtime ani executor nemohou provést přímý DELETE, upravit origin marker
  nebo přepnout na chráněného ownera či control. Runtime nemůže změnit expiry.
- Oba expiration DELETE, skutečné interval/ETA cascades a marker výsledku
  sdílejí původní transakci. Zachované state, erasure operace a permanentní
  revokace byly porovnány přesně, ne pouze počtem řádků.
- Registrace je neměnná, claim jednorázový a vázaný na původní celý XID8,
  PID, backend start a store incarnation. Nový XID po rollbacku jej nepoužije.
- Executor drží stejný origin lock jako resolver. Busy zůstává pending;
  durably committed seal odmítá pozdní vstup ještě živého původního backendu.
- Vnitřní seal JSON po control rollbacku neprokazuje uzavření: původní
  transakce pak může legitimně provést práci. Terminal předpokládá skutečný
  control COMMIT a nový readback stejného originu.
- Chybějící origin zůstává neznámý. Pevný cutoff zachová pozdější řádky;
  expirace není omezena na jednu historickou verzi grafu.
- Původní permanentní receipt guard nadále odmítá odvolaného přispěvatele
  a původní quality constraint odmítá neplatnou rychlost.
- Origin journal neobsahuje contributor hash, manifest, GPS ani vazbu
  účtu na denní pseudonymy. Aplikační tabulky, vlastníci a guard se nezměnili.

## Návaznost a hranice nasazení

Mechanismus vychází z konkrétního COP SQL kandidáta revize
`9f5a1ab54a4253fd0dafc38637c5f8c6ec366807`, SQL pin
`40a486bc72046291ad2287a489d3688a1f2d2bbbb53f4d7202c6192de91af8cf`.
COP doložil vlastní PG18.6 devět případů a samostatný outer-seal případ.
SIM jejich zdroj, piny a proofs přečetl; nespouštěl je znovu a nepřičítá je
k tomuto výsledku. Dřívější lifecycle/workspace testy mají vlastní záznam.

COP následně uzavřel nezávislou čtecí revizi publikovaného SIM kandidáta
`79acd91795902081558d95431a88d73fa81c5b6e`. Jeho záznam v COP revizi
`2f94ec2`, `docs/testing/account-safety-driver-sql-candidate-review-20261014.json`,
má SHA-256 `fce4a3854c49d89f1eba8a03e95c56e6a27006ed8f2bd4fd1025af0024b74521`.
Čtyři source piny a proof souhlasí; samostatný reviewer doložil shodu těchto
pěti pinů před a po své revizi a nenašel konkrétní P1/P2 v mechanickém rozsahu.
SIM tento připnutý záznam přečetl a piny porovnal. Jde o čtecí kontrolu,
nikoli nový PostgreSQL běh nebo produkční či restore akceptaci.

Role a `SECURITY DEFINER` funkce v tomto kandidátu nejsou produkčním
oprávněním. Skutečný Root producent musí vlastnit origin/control spojení,
chráněný execution kanál a commit/readback handling. Dále musí být přijatá
whole-COP retenční/report politika, stabilní writer/protection generace,
store continuity a skutečná obnova. Lokální JSON, XID nebo úspěšný SQL test
tyto důkazy nenahrazují.

Před odebráním live runtime DELETE musí společný source kandidát adaptovat
revoke a erase spolu s provisioning/recovery. Zachová contributor/operation
zámky, příjem za fence, původní actor/request/acceptedAt a unlink hranici.
Samostatný contributor executor z COP fixture se nepřebírá.
Pevný expiry plán zůstává neaktivní, dokud tyto podmínky neprojdou akceptací;
source test neobchází `DRIVER_RETENTION_UNBOUND` ani nepřepíná služby.
