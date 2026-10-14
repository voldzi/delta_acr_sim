# Ověření chráněného úklidu měření Jízdy

Zdroj `25de85abf2ab00ad125c9482f1ddb70bb81cfce2`, tree
`3342da69817b4f26d1dd5065aca7ba68c239e7a4`, ve větvi
`codex/sim-account-erasure-release` odstraňuje automatický start retenčního
úklidu a přímý SQL obchvat v samostatné údržbě. Produkční consumer ochrany
obnovy ještě není připojený. Kandidát se nesmí nasadit, dokud nepřevezme
retenční úklid přijatá skutečná autorita a neprojde společná akceptace.

## Změna životního cyklu

Konstruktor store neprovádí SQL ani nevytváří časovač. `init` ověří
skutečné databázové spojení a potřebné tabulky, nikoli oprávnění k úklidu.
`start` a `runOnce` potřebují owner-bound consumer. API composition jej
bez vazby odmítne ještě před retenčním init; ostatní SIM/IZS API zůstane
nezávislé. Samostatný entrypoint má pevný compiled import, nepřijímá
alternativní DB nebo producer a ve výchozím `UNBOUND` nečte secrets ani
nevytváří DB pool.

Consumer předává přesný frozen context s ownerem `sim_driver_measurements`
a canonical UTC cutoff. Jde jen o lokální TypeScript seam, ne přijaté
nativní body, replay nebo grant. Oba dočasné DELETE používají stejný
cutoff v jedné transakci. Permanentní revokace, erasure ledger a stávající
per-contributor zámky zůstávají zachované.

Lifecycle rezervuje rozpracovanou práci před callbackem a nepřekrývá ji
s dalším úklidem. `close` zastaví další přijetí a čeká na skutečný callback
včetně SQL COMMIT/ROLLBACK a release před uzavřením poolu. Předčasné
ukončení promise consumeru není dokončení SQL. Toto čekání neprokazuje
nativní drain nebo známý abort.

## Vlastní testy SIM

Hlavní ověření proběhlo 14. 10. 2026 na Node 24.16.0 a pnpm 10.33.0.
Přesné příkazy, piny a meze jsou v
[strojovém záznamu](2026-10-14_DRIVER_RETENTION_LIFECYCLE.json).

| Kontrola | Výsledek |
| --- | --- |
| Cílený lifecycle, store, CLI a route composition | 37 PASS, 0 FAIL; syntetické spies, bez DB spojení nebo HTTP listeneru |
| Celý workspace | 628 PASS, 0 FAIL, 6 SKIP; cílených 37 je již zahrnuto v celkovém počtu |
| Erasure schémata | 70 PASS; samostatné syntetické contract cases |
| Workspace typecheck a samostatný strict test/CLI typecheck | PASS |
| Workspace build a syntaxe maintenance MJS | PASS; Docker image se nestavěl |
| Skutečný compiled standalone entrypoint | Očekávané `DRIVER_RETENTION_UNBOUND`, bez DB cesty |
| Skeleton, OpenAPI validace a diff check | PASS; závazných 151 paths a 273 schemas beze změny |

Šest přeskočených případů patří ke stávající opt-in PostgreSQL sadě.
Nejsou uvedeny jako prošlé. Historické vlastní PostgreSQL a COP HTTP
důkazy mají své jiné revize a nesčítají se s tímto výsledkem. Placeholder
smoke výstup webového package není novou vizuální akceptací.

Ověřené závody zahrnují skutečný asynchronní init před startem, init/close a
start/close, souběžné idempotentní starty, nepřekrývající se cleanup,
early success/error consumeru s rozpracovaným SQL, pozdní či duplicitní
callback a oba pořadí vypořádání route runOnce a store.close. Testy také
odmítají mutable, accessor a neplatný context před SQL, ověřují jeden
cutoff, rollback druhého DELETE a nedotčený permanentní ledger.

Nezávislá full-read runtime revize nenašla blokující P1/P2 nález; neprovedla
druhý testovací běh. Nové composition cases po doplnění přečetl hlavní SIM
agent a spustil finální 37-case i celou workspace sadu. Dřívější 27-case
mezirevize se nezapočítává znovu. Cache permission a dvě nesprávné startup
invokace compileru byly opraveny bez změny zdroje; konečné příkazy prošly.

Po změně byl jednou vyžádán Chroma reindex. CLI jej odmítl kvůli identitě
managed pracovního stromu (`native retrieval does not accept a replacement
repository identity`, exit 2). Index se nenahrazoval ani nepřestavoval;
revize zdrojů použila přímé čtení a Git diff.

## Nasazení a návrat

Žádný image, příznak, produkční DB, grant, secret, síť nebo skutečný účet
se touto prací nezměnil. Kontrakt `sim-driver-measurements-v1`, režim
`shadow_only`, veřejné cesty, auth a absence raw GPS v úložišti a logu se
nemění. Stávající fyzický retenční úklid nesmí být nahrazen unbound
kandidátem, ani se samotným vypnutým příjmem.

Další krok je přijetí skutečného owner-maintenance/replay consumeru s
neměnným cutoff v aplikační i samostatné cestě, aktuální autorita obnovy
a společné COP–SIM ověření commit/outcome, retence a restore. Lokální
typovaný port, metadata DB nebo úspěšný syntetický callback tyto podmínky
nenahrazují. Postup aktivace i návratu je v
[runbooku 19](../runbooks/19_COP_ACCOUNT_ERASURE_PRODUCTION.md).

Inventář nyní připíná 32 souborů a 17 nezměněných HTTP operací. Předchozí
publikovaný inventář z `03f5408` zůstává byte-identický v
[archivu](2026-10-14_SIM_ACCOUNT_SAFETY_INACTIVE_INVENTORY_03f5408.json).
Neaktivní balíček stále nemá instalaci schválenou ani proveditelné actions;
návrat zdrojové změny neznamená vrátit do provozu nefencovaný starý obraz.
