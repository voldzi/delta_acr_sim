# Ověření opt-in napojení chráněných driver operací

SDA obsahuje konkrétní opt-in náhrady revoke, erase, ACK a retenčního úklidu.
Finální kontrola dne 15. 10. 2026 v 08:03 Praha prošla: **571 testů, žádné
selhání, 6 záměrně vynechaných volitelných PostgreSQL testů**. Kontrola
typů a sestavení celé dotčené služby rovněž prošly. Přesné piny finálního
zdroje a počty obsahuje [souhrnný záznam](2026-10-15_DRIVER_GUARDED_APPLICATION.json).

## Rozsah implementace

Přítomnost interních guarded voleb zapne samostatnou větev bez náhradního
aplikačního DML. Root origin reference se předává jen interním argumentem,
nikoli veřejným body nebo business UUID. Chybějící kontext, skutečný port
nebo admission nedovolí chráněnou operaci. Výchozí dosavadní režim bez
guarded volby zůstává před koordinovanou migrací zachovaný.

Revoke přijímá pouze potvrzený původní scalar počet. Nejasný COMMIT,
pending, no-effects, chybějící nebo neplatný počet znamenají 503, ne novou
mazací operaci nebo odhad nula. Lokální opakování nejasného originu je
probe-only; durable recovery po restartu musí dodat skutečný Root port.
Retence posílá pouze přesný expire origin a pevné tělo bez app cutoff.

Erase a ACK v guarded větvi nemění tabulky přes runtime pool. Po známém
COMMIT provádějí nové actor/request-bound read-only čtení ledgeru s novým
účelovým admission. Receipt má kumulativní count a první acceptedAt,
nikoli počet posledního SQL vykonání. HTTP GET/preflight neprovádějí probe
ani seal. ACK nevzniká ze samotného `no_report` nebo void callbacku.

Guarded gate kontroluje scoped read/intake profil včetně účinných
sloupcových práv a vyžaduje samostatný účelový Root admission. Legacy
zero-argument proof není jeho náhradou. Vypnutí nových erasure operací
umožňuje pouze resume již durable operace se shodným actor a requestem,
stále se všemi aktuálními kontrolami. Guarded volba a porty se zachytí při
konstrukci; pozdější změna caller options neotevře legacy SQL. Legacy
instance si zachovávají původní config/callback chování.

## Testovací evidence

Čtyři nové soubory obsahují **99 syntetických mock testů**, které jsou
součástí uvedených 571, nikoli navíc:

| Soubor | Úspěšné případy |
| --- | ---: |
| `driver-erasure-guarded-store.test.ts` | 24 |
| `driver-guarded-execution.test.ts` | 21 |
| `driver-guarded-measurement-store.test.ts` | 46 |
| `driver-guarded-routes.test.ts` | 8 |

Sada zahrnuje chybějící/poškozené kontexty a výsledky, příjem správného
scalar receipt, probe-only opakování, změněné tělo stejného originu,
současné pokusy a close během skutečné lokální promise. Ověřuje také
striktní těla po JSON snapshotu, přesné předání oběma store komponentám,
oddělení business/origin UUID, scoped admission, actor/request readback,
vypnutý režim s přijatou operací a zachování legacy větve.

Úplná sada běžela s odpojeným `DRIVER_MEASUREMENTS_TEST_DATABASE_URL` a
externím routing fixture adresářem. Použila jen lokální testovací HTTP
servery, syntetické porty a mock databázové objekty. Neprovedla nový
PostgreSQL běh, skutečné Root ověření, volání OpenAI ani mazání reálného
účtu. SHA-256 úplného lokálního Vitest JSON reportu je
`1530f732c36b1675b484a283d8db4859d967ab46d664676d4fa001396501842f`.
Piny souhrnu byly zachyceny po úspěšném finálním běhu.
Skeleton, OpenAPI sanity (151 cest, 273 schémat), diff check a následné
porovnání všech source pinů prošly. Celý monorepo build/test nebyl součástí
tohoto SDA-only kroku. Chroma reindex odmítl náhradní repository identity;
index se neobcházel ani nepřestavoval.

První úplný běh našel dva zastaralé provisioning mocky: nepovolovaly novou
pevnou čtecí kontrolu guarded namespace a ukončily se kódem 98. Opravený
mock dál odmítá jakýkoli skutečný zápis; změna nezavedla DB připojení.
Závěrečná revize uzavřela tři konkrétní regresní opravy: exact snapshot
validaci, disabled resume a zachycení guarded režimu při konstrukci.
Čtecí revize není další testovací běh.

Předchozí 18-case SQL důkaz i frozen 11-case expiry vstupy zůstaly beze
změny a k tomuto výsledku se nepřičítají. Jejich skutečné SQL transakční
zkoušky mají vlastní záznamy. OpenAPI a veřejné endpointy zůstávají stejné.

## Nasazení a návrat

Zdroj ještě není aktivní produkční propojení. SIM nemá připojenou skutečnou
Root delivery factory. Účelový read admission, per-HTTP context delivery,
enrollment a restore zůstávají otevřené implementační a společné akceptační
kroky, nikoli pouze čekající souhlas. Zdroj vykonavatele nebo carrieru COP
sám tuto chybějící aplikační vazbu nevytváří.
Nevytvářejí se produkční role, tajemství, porty ani pozitivní verifier.

Samotná instalace SQL 003 nebo výměna SDA obrazu není bezpečný cutover.
Musí současně přijmout skutečné writery, retenci, scoped granty a Root
doručování. Do té doby zůstává dosavadní produkce nezměněná. Před takovou
migrací lze zdrojovou opt-in větev nepoužít; po odebrání runtime DELETE se
rollback nesmí vrátit ke starému writeru ani znovu udělit blanket DML.
Zachovat ledger/fences, zastavit nové operace a nejasné efekty zjišťovat
na původních originech podle runbooku 19.
