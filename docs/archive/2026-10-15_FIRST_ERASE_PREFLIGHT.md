# První ERASE: preflight před zápisem, receipt po zápisu

Datum: 15. 10. 2026. Rozsah: zdroj a syntetické aplikační testy.
Produkční databáze, migrace, oprávnění, tajemství, služby ani příznaky
nebyly touto opravou změněny. Veřejný OpenAPI kontrakt zůstává shodný.

## Příčina a oprava

Guarded store před ERASE požadoval `purpose=receipt`. Skutečný čistý matcher
ale tento účel správně odmítá bez existujícího actor-bound ledger řádku.
První smazání tak nešlo zahájit. Původní testová náhrada vracela receipt
bez ohledu na ledger, a chybu neodhalila.

Před ERASE se nyní požaduje `preflight`. Před ACK i po potvrzeném zápisu
obou druhů se vyžaduje `receipt`. Zůstávají kontroly actor/request vazby,
checkpointu, publikace, skutečně známého origin výsledku a příznaku:
vypnutý příznak nepovoluje novou operaci. Nejistota vrací 503, nikoli
kladný starší ledger, legacy proof, automatický probe nebo náhradní zápis.

## Ověření a přesné zdroje

`apps/situation-data-api/test/driver-erasure-guarded-store.test.ts`:
25/25 PASS. Test skutečně volá čistý `matchDriverReadPolicy`, ale databáze,
Root porty, reference, příznaky i údaje jsou syntetické náhrady. První ERASE
začíná prázdným ledgerem; nový řádek vznikne až v náhradě execute.
Pořadí je preflight bez operace → execute → receipt s operací. Dále se
ověřuje chybějící receipt před ACK, chybějící výsledek po known commit,
cizí actor/request, zakázaný nový zápis při vypnutém příznaku, změněný
checkpoint a nezměněné ochranné chování při chybách.

SHA-256 store:
`8833c76a45747376a32fd95dc1e7186120f804e86850b5cead20f7393c020a21`.

SHA-256 testu:
`0e248378cf128ee2bcd0dee27f8f35c38c4c422c2a4952e92deabe703e313dee`.

Následné `pnpm typecheck`, `pnpm build` a `pnpm test` prošly:
844 PASS, 6 opt-in PostgreSQL SKIP. Tyto testy nejsou skutečné Root
admission, nativní transport, HTTP životní cyklus, obnova ani produkční test.

## Nasazení a návrat

Oprava sama neuzavírá držení jedné autority po dobu celého požadavku.
Navazující scoped čtení/podpis musí používat skutečný WeakMap mutation
kontext, nikoli další shared metadata session nebo výjimku pro ordinary
read při pending cleanup. Kopie kontextu ani samotné UUID nejsou autorita.

Produkční aktivace zůstává podmíněna společnou COP–SIM akceptací a
nezávislou startup/restore karanténou. Návrat nesmí odstranit ledger,
permanentní fences, opravu ETA vazby nebo ochrannou karanténu starých
obrazů. Při nejistotě se zastaví dotčené COP vstupy; sdílené SIM/IZS
identity a funkce zůstávají mimo tento scope.
