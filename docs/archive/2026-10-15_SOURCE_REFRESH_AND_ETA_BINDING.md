# Ověření obnovení source důkazu a vazby ETA

Datum: 15. 10. 2026. Rozsah: zdroj a izolované syntetické testy.
Produkční databáze, přístupy, služby ani příznaky se tímto krokem neměnily.
Veřejný OpenAPI kontrakt zůstává beze změny.

## Samostatné výsledky

| Sada | Výsledek | Skutečně ověřená hranice |
| --- | --- | --- |
| [Source refresh SQL CAS](2026-10-15_SOURCE_REFRESH_CAS_SQL.json) | 8/8 | Skutečné metadata001/reader002/SQL004, omezené role, přesná struktura, původní řádkové digesty, expirace, souběh a povinný INSERT zámek |
| [Root source refresh](2026-10-15_ROOT_SOURCE_REFRESH.json) | 6/6 | Skutečný common, JWS/Ed25519, ověřené TLS, metadata session, Driver i AI, neměnné finance, custody, skutečná expirace a HOLD |
| [ETA contributor vazba](2026-10-15_DRIVER_ETA_CONTRIBUTOR_BINDING_SQL.json) | 6/6 | Odmítnutí historického nesouladu bez změny, čistá SQL007 migrace, FK INSERT/UPDATE, izolace dvou přispěvatelů a oba směry skutečného souběhu |

Tyto skupiny se nesčítají s historickými common 22/22, policy-lineage 8/8,
inventory 12/12 ani samostatnými důkazy COP. Původní zdroje a záznamy
zůstaly hashově beze změny.

SHA-256 výsledných JSON záznamů v uvedeném pořadí:

```text
439fa79113dc2fe19d5ba1596e8505bd1377e6e49936cee53802d0ff1d8544c6
07c417f025ecdf6583ecc29ee2140c8de7a3e20c8f42c8fd2cb8d9215d7b4710
0e496c825ccb40e48e3a8c7ee4d10000fd72b018ed4b71b36cc7e168ab551d99
```

## Přesné zdroje a izolace

Root common má SHA-256
`34a601aec8ad8d32095c9baf778a3a829dbda6159f7c4fd1e28aa22be6d0feb0`;
SQL004 má
`48dbf4f816af0b89c913a5361ae9ddf61b827dc61db0ce242100ea5189a958cf`;
SQL007 má
`135acb29c58734e232891aa9b61fac3e6520b6dd7209a57dbd5dc8240fbc5942`.
Ostatní přesné piny runnerů, fixtures, importů, SQL a neměnných předchozích
důkazů obsahují příslušné JSON záznamy. Root sada četla COP importy pouze
z neměnných Git objektů revize
`17d52541b0e8bffc7217f680714cd73f607644b6`, nikoli z jejího rozpracovaného stromu.

Všechny sady použily již místně dostupné pevné obrazy Node 24.20 a
PostgreSQL 18.6, nové vlastní kontejnery s `network=none`, žádný image pull
nebo build, veřejný port, host bind, volume či externí zdroj. Databáze byly
nové a na tmpfs; běh Root používal uvnitř kontejneru skutečné ověřované TLS.
SQL-only sady používaly pouze vlastní Unix socket bez TCP. Testovací
kontejnery a úspěšné pracovní kontexty byly odstraněny bez globálního prune.
Po dokončení diagnostiky bylo odstraněno také devět vlastních neúspěšných
dočasných kontextů se syntetickými údaji; archivní záznamy zůstaly zachované.

## Co source refresh prokazuje

Pevný omezený účet dokáže vložit právě jeden nový refresh pod původní
stále platnou autoritou. Reader ani běžný runtime nedostávají právo INSERT,
změnu role nebo spuštění cizí cesty. Chybějící, sdílený či jinou session
držený zámek, READ ONLY, nesprávná izolace, vadný tvar, starý CAS, původní
expirace a spotřebovaná ID se odmítají. Dva skutečné soupeřící CAS mají
jednoho vítěze; přímý enroller INSERT čeká na stejném zámku a jeho čekání
bylo skutečně změřeno.

Root uloží skutečné podepsané JWS, intent a dispatch a ověří potvrzený
nový řádek dvakrát. Původní uzavřený veřejný kontext se nepřepíše; nový
ordinary kontext po známém ukončení vidí nový proof. Kontrolní součty
všech ostatních metadata, cílových tabulek a nenulových finančních součtů
v obou skutečných budget views zůstávají shodné. Helper neobnovuje
checkpoint, registraci, owner policy ani frontier anchor.

Root host/app observation a přijímané enrollment podklady byly syntetické;
nativní SELF identita, podpisy, TLS, SQL a zámky byly skutečné. Test starého
kontextu pokrývá dříve uzavřenou neměnnou referenci, nikoli skrytý hook do
privátního kontextu refresheru. Tato sada neověřovala ztracený COMMIT,
nejasný target END, nativní packet transport nebo restartové dohledání originu.

## Co oprava ETA prokazuje

Původní FK dovoloval ETA přispěvatele A pod dávkou B. SQL007 tento
historický nesoulad odmítne před DDL, aniž změní data, ACL nebo schéma.
Odstranění jediného chybného ETA v dalším kroku bylo výslovné syntetické
testovací nastavení, nikoli chování migrace nebo návod pro produkční opravu.

Na čistých datech se původní FK atomicky nahradí validovanou immediate
trojsloupcovou vazbou. Nesprávný hash nelze vložit ani přepsat; cizí dávka,
ETA a příspěvky zůstávají zachované. Oba směry souběhu prokázaly skutečné
FK čekání mezi dvěma backendy a nulové ETA po potvrzeném smazání rodiče.
Reader004 stále rozpoznává schéma, privilege fingerprint se nezmění,
schema fingerprint se naopak změní a starý pin skutečný matcher odmítne.
Nový pin z DB nebyl použit jako kladná náhrada nezávislé Root politiky.

## Opravy zjištěné při běhu

[První neúspěch](2026-10-15_ROOT_SOURCE_REFRESH_INITIAL_FAILURE.json) zůstal
odděleným záznamem, nikoli přepsaným PASS. Následná omezená diagnostika
určila SQLSTATE 42601 na původní pozici 19790: vnořený CASE v PL/pgSQL IF
potřeboval závorky. Oprava mění pouze syntaxi, nikoli oprávnění nebo CAS.
Další dílčí běh správně odmítl vadná oprávnění složky, ale test čekal
nesprávný kód; očekávání bylo opraveno na přesný `GUARD_PARENT_CUSTODY`
z připnutého Root verifieru, bez rozvolnění kontroly.

První SQL-only běh dokončil případy, ale závěrečné čtení původního souboru
ukončil místní ETIMEDOUT. Nebyl vydán přijatý výsledek ani použit náhradní
pin. Výše uvedené výsledné záznamy pocházejí z nových úplných běhů včetně
úspěšného ověření původních souborů před i po testu.

## Produkční podmínky a návrat

Produkční mazání zůstává vypnuté. Před aktivací stále chybí samostatně
ověřená omezená Root instalace a skutečné přijetí vazeb/politik, úplný
životní cyklus registrací a důkazů, dohledání původního refresh originu po
restartu a technicky vynucená startup/restore karanténa i pro starý image.
Následovat musí společná akceptace skutečných COP a SIM executorů,
publikace/drain a obnovy; syntetický podpis nebo DB readiness je nenahrazuje.

SQL007 nesmí převzít starou policy nebo automaticky opravit historický
nesoulad. Před produkčním DDL se znovu ověří data a omezený migrační plán.
Změněný schema pin nelze protlačit historií A→B určenou pro stejné piny;
přijetí nové instalace či runtime vazby vyžaduje vlastní enrollment/drain
postup při zachování dosavadních permanentních fences.
Návrat nesmí odstranit permanentní fences, zrušit novou FK ochranu nebo
zpřístupnit starý obraz mimo nezávislou karanténu. Při nejistotě zůstávají
dotčené COP vstupy blokované; společné SIM/IZS identity se nemažou.

## Běžné kontroly repozitáře

`pnpm typecheck`, `pnpm test` (843 PASS, 6 opt-in PostgreSQL SKIP),
`pnpm build`, skeleton a OpenAPI validace prošly. OpenAPI má stále
151 cest a 274 schémat. Hláška package smoke testu není nové vizuální
ověření prohlížeče. Chroma reindex zůstává omezený dříve zjištěnou
neshodou nativní identity checkoutu; nebyl obcházen přijetím jiného kořene.
