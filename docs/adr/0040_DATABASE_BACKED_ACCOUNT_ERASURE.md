# ADR 0040: Dokončení mazání přes databázové fences a nezávislý replay

Stav: zvolená zdrojová cesta; produkční aktivace až po společné akceptaci.
Datum: 15. 10. 2026. Navazuje na ADR0039 a COP ADR0055.

## Problém a zúžení

Požadavkem je jedno skutečné, opakovatelné smazání COP/Jízda účtu při
zachování identity, oprávnění a dat SIM/IZS. Není jím vybudování systému
odolného proti úmyslně škodlivému vlastnímu backendu nebo správci.
Dosud nenasazené Root/native, A/B/C registry, pidfd a pětisekundové podpisy
byly vlastní zvolenou implementací, nikoli samostatným požadavkem produktu.
Jejich neúplná integrace zablokovala již existující databázové mazání.

Pro explicitní `database_v2` proto nahrazujeme tento nenasazený privilegovaný
tok konkrétními transakcemi PostgreSQL a důvěryhodným správcem obnovy.
Root zdroje a neměnné testovací důkazy se zachovají, nepřepíší a nebudou
vydávány za produkčně instalované nebo za důkaz této nové cesty.
Výchozí `root_native_v1` se potichu nemění; při jeho selhání neexistuje
fallback na databázovou variantu. Produkční přepnutí je samostatný krok.

## Zachované nepřekročitelné požadavky

- Službová autentizace a samostatná podepsaná actor attestace vážou issuer,
  subject, původní router alias, operation ID a přesný účel mazání.
- COP zastaví nové požadavky účtu a uloží neměnnou obnovitelnou úlohu;
  nesmaže sdílenou Keycloak identitu ani přístup do SIM.
- SQL002 Driver a SQL003 AI zůstávají skutečné transakční fences, zámky,
  idempotence a minimální DML. Guarded SQL003 Driver se pro tuto cestu
  neinstaluje; nedochází k odebrání oprávnění potřebných původními writery.
- 202 je čekající stav; 200 vyžaduje ověřený online rozsah. Rozpracovaná
  či nejistá provider rezervace se nevypořádává podle časovače.
- Náklady a tokeny přejdou do schválených nespojovatelných součtů do
  dalšího měsíce UTC; mazání neobnoví finanční ani uživatelské stropy.
- Po obnově nesmějí být data zpřístupněna před replay a kontrolou.

## Konkrétní databázová autorita

Nezávislá DB `cop_account_safety_guard` obsahuje oddělené schéma
`sim_erasure_guard_v2` z migrace 010. COP vlastní svůj globální journal;
SIM vlastní pouze `store`, `owner_binding`, `tombstone`. Žádná legacy guard
tabulka se nemění. Enrollment je výslovný, nikoli odvozený z prázdné DB.

Každá cílová DB obsahuje read-only `sim_erasure_dataset_binding` z migrace 011. Aplikace porovná skutečně načtený guard store, config fingerprint,
store/incarnation, restore generation a checkpoint s nezávislou registrací.
Chybějící, cizí, quarantined nebo změněná vazba znamená odmítnutí.

Instalaci provede jeden koordinovaný offline administrační skript nad
stávající guard DB, nikoli další Root runtime. Komponentový fingerprint
zahrnuje skutečný hash secret, actor secret a issuer každé služby; společný
fingerprint váže oba. Loadery přepočítají vlastní komponentu při startu,
aby chybná rotace klíče nemohla cílit na zdánlivě prázdný namespace.
Privátní výslovně přijatý manifest sám není důkaz pravdivosti identity.
Příprava ponechá oba erasure flags vypnuté a report inventory nepotvrzený.
Target i guard TCP přes HAProxy vyžadují ověřený hostname/certifikát se
stávající schválenou veřejnou CA; COPův chráněný Unix socket se nemění.
Legacy deploy nesmí zahodit enrollment přepsáním `.env`.

Guard runtime má jen vlastní řádky, SELECT/INSERT tombstones a UPDATE
jediného `replay_sequence`. Nemůže měnit přijaté vazby nebo ready stav,
vytvořit enrollment ani mazat journal. Trigger navíc zakazuje přepsání,
DELETE a TRUNCATE tombstones. Cílový runtime má marker pouze ke čtení.

Před prvním target zápisem se skutečně COMMITne neměnný guard tombstone.
Nejistý výsledek se dohledává pod stejným ID, nikdy náhradním UUID.
Každý start před HTTP listen přehraje **všechny** vlastní záznamy do
skutečných target fences; kurzor obnovený s aplikační DB se nepovažuje
za důkaz. Replay zachová původní čas a neměnné actor/request vazby.
Cursor se posune až po skutečném target COMMIT a kontrolním readbacku.

## Minimalizovaný obsah replay

Driver ukládá pouze operation HMAC, finální contributor HMACs a počet
manifestových položek. Neuchovává raw denní pseudonymy, dny, GPS ani raw
principal. AI ukládá pouze již existující cílový hash COP aliasu. Řádek
obsahuje ještě operation UUID, actor HMAC, request hash a přijetí.

Jde o novou účelově omezenou pseudonymní vazbu na mazací operaci, nikoli
anonymní data nebo archiv pohybu. Je nutná k obnově bez opětovného získání
smazaného účtu. Přístup je omezen na příslušnou službu a správce obnovy.
Nemá sedmidenní TTL; zrušení ochrany vyžaduje samostatné retenční rozhodnutí
po zániku všech relevantních záloh/outboxů, nikoli běžný úklid měření.

## Publikace a obnovy

HTTP aggregate/quality čtení drží skutečný sdílený PostgreSQL session zámek
až do ukončení odpovědi. Replay/delete používá exkluzivní protějšek.
ACK čeká na skutečný barrier, nikoli kladný callback. Tato source cesta
neprokazuje bezpečnost externího souborového exporteru: před produkční
akceptací musí být inventarizován a zastaven/invalidován nebo připojen ke
stejné ochraně. Existence reportů vylučuje nepravdivé `no_report`.

Správce zastaví služby i vnější expozici před obnovou; guard se neobnovuje
spolu s aplikačními databázemi. Explicitně se zaregistruje nová incarnation,
provede replay a ověření všech owner rozsahů před povolením provozu.
Při obnově celého clusteru musí být nejprve obnoven nejnovější nezávislý
guard journal bez mezer. Neznámý frontier znamená karanténu, ne prázdný účet.
Starý obraz bez startup replay se nesmí z runbooku vrátit do expozice.

## Akceptace a neplatná tvrzení

`scripts/test-database-erasure-http.mts` testuje skutečné HTTP handlery,
produkční DBv2 loadery a omezené PG účty v ověřeném lokálním clusteru.
První průchod 10/10 ověřil obě SIM owner větve, ne celý COP controller.
Společný COP HTTP/PG průchod je další konkrétní test, nikoli nový protokol.
Žádný test nemá volat poskytovatele nebo mazat skutečný účet. Produkce,
fyzická obnova záloh a reálný iPhone se tímto dokumentem neprohlašují za hotové.
