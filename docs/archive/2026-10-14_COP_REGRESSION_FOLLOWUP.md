# Navazující regresní ověření COP

Datum: 14. 10. 2026. Výsledek COP je doplňkovou zdrojovou evidencí,
nikoli akceptací produkční ochrany, přihlášení, iPhonu nebo obnovy.
[Původní COP receipt v komitu ce052cf](https://github.com/voldzi/delta_acr_cop/blob/ce052cf35b11071a49a62770ad03af2dde0cccee/docs/testing/account-erasure-final-regression-20261014.json)
má SHA-256 `b080ce16a793f81980ffa410f22c6be78d23d19ab6e483c3616d30c6b0955030`.

## Výsledek a způsob vyhodnocení

První úplný běh COP zahrnul 247 souborů a skončil se 2 412 úspěšnými,
4 neúspěšnými a 21 přeskočenými případy. Podle receipt chybějící PostGIS
v místním PostgreSQL 18.3 způsobil čtyři startovací chyby a zablokoval
třináct dalších případů. Původní neúspěšný report zůstává zachovaný.

Následně COP zopakoval pouze těchto 17 zablokovaných případů ve dvou
souborech proti skutečnému PostgreSQL 17.5 s PostGIS 3.5.2. Všech 17
prošlo, žádný nebyl přeskočen. Sjednocená evidence nahrazuje původní
výsledky těchto stejných případů podle názvu a výskytu; nepřičítá duplicitní
úspěchy. Výsledkem je 2 429 úspěšných, žádný zbývající neúspěšný a osm
starších přeskočených opt-in PostgreSQL případů z celkem 2 437.
**Nejde o jeden bezchybný úplný běh.** Osm přeskočených případů není
splněným testem a recovery není během PostgreSQL 18.3 s PostGIS.

Samostatná čtecí kontrola SIM ověřila všechny čtyři dostupné raw/evidence
reporty proti jejich hashům a znovu porovnala názvy i opakované výskyty
testů. Recovery nahrazuje přesně čtyři původní failures a třináct skipped;
nepřidává znovu již úspěšný případ. Seznam osmi zbývajících skipped
odpovídá reportům. Tato kontrola nespouštěla testy ani databázi.

Samostatné nové COP consent testy PostgreSQL 18.3 a předchozí společné
[controller/consent HTTP ověření proti SIM](2026-10-14_COP_SIM_CONTROLLER_AND_PEER_FIXTURES.md)
mají vlastní piny a rozsah. Jejich počty se k regresní sadě nepřičítají.
SIM tímto převzetím znovu nespouští celou sadu COP ani neupravuje
zmrazené předchozí důkazy.

## Zdrojová hranice

Komit `ce052cf35b11071a49a62770ad03af2dde0cccee`, tree
`ab057fd8646ca24a403f8630e1d3424812b5c0b5`, mění pouze dokumentaci.
Runtime COP zůstává `898cd5132f513259b226d5beff5c3876156b56e7`.
SIM ověřil receipt, jeho hash a nezměněné aplikační zdroje mezi těmito
revizemi. Pro zopakování připnutého společného runneru je stále nutný
čistý checkout přesné runtime revize 898, nikoli novější docs-only HEAD.

COP v receipt doložil zastavení a odstranění vlastního izolovaného PG
clusteru, odstranění vlastního PostGIS kontejneru i dočasného syntetického
přístupu. Žádný skutečný účet nebo produkční data nebyly tímto testem
mazány. Tato tvrzení jsou evidencí vlastníka COP, ne novým produkčním
auditem SIM.

## Produkční podmínky zůstávají otevřené

Testy nepřijímají skutečný native producer, peer/runtime autoritu,
nezávislou continuity/anchor nebo restore. Stávající aplikační transakční
ochrany se nenahrazují prázdnou guard metadata DB, samotným podpisem
či peer booleanem. Běžný COP chat a zachovaný SIM/IZS přístup zůstávají
v dosavadním provozu. Nový gated obraz, pozitivní verifier, runtime
propojení a mazání skutečných účtů se tímto výsledkem neaktivují.
