# COP/SIM mazání: oddělené ověření řadiče a testovacího peer klienta

Datum: 14. 10. 2026. Stav: zdrojové testy prošly, produkční propojení a
obnova nejsou akceptované. [Strojový receipt a přesné piny](2026-10-14_COP_SIM_CONTROLLER_AND_PEER_FIXTURES.json).

## Zmrazené zdroje

SIM: `6daa969bd93542009b3edab964dbd466cbed65c5`, tree
`a8a84b257c2de74dd620379c1c9eeabd4702bdf6`, větev
`codex/sim-account-erasure-release`. Testovaný COP:
`898cd5132f513259b226d5beff5c3876156b56e7`, tree
`a41ee5b065216dfb5e8ab37ee020fc766b66a5c6`. COP checkout byl čistý a piny
zdrojů i receipt byly zkontrolované před importem a po běhu. Node 24.16.0,
pnpm 10.33.0. Aktuální aplikační kód, migrace a OpenAPI se proti dříve
ověřenému SIM `7bd5a63` nezměnily.

## Výsledky vlastního opakování SIM

| Ověření | Výsledek | Přesný rozsah |
| --- | --- | --- |
| Offline peer codec/client v1 | 61/61 PASS, 168 výměn | Pouze injektované packety v paměti, nezávislé Ajv2020 request schema; žádný proces, Python wrapper, socket nebo PostgreSQL. |
| Řadič COP a místní souhlasy proti SIM HTTP | 8/8 PASS, 53 požadavků | Skutečný COP controller, in-memory consent logic, composition a adaptéry; skutečné SIM Express handlery na vlastním loopbacku. |
| Jednotkové testy SIM | 591 PASS, 0 FAIL, 6 SKIP | Šest existujících opt-in PG testů je zde přeskočených; dřívější samostatných 41 SQL testů se nepřičítá. |
| Typy a sestavení | PASS | Celý workspace a samostatný strict TypeScript check všech tří nových fixture souborů. |
| Erasure schema | 70 PASS | Osm binding REST paths; OpenAPI 151 paths/273 schemas, nezměněné. |
| Skeleton, OpenAPI build/check/validate, diff | PASS | Žádné nové veřejné rozhraní ani runtime import klienta. |

Reindex Chroma byl zkusen, ale native CLI odmítl náhradní identitu tohoto
managed pracovního stromu (exit 2). Hlavní index nebyl obnoven ani ochrana
obejita; review použilo cílené přímé čtení zdrojů. Nejde o splněný reindex.

Samostatný nový controller runner ověřil:

- První předání až po skutečně uloženém potvrzeném COP jobu, bez požadavku
  na předem existující SIM receipt.
- Driver 202 ponechá souhlasové metadata a všechny doložené staré outbox
  dny; 202 není dokončení.
- Vlastní přijatá operace pokračuje při vypnutém příjmu. Cizí/neexistující
  operace, chybějící identita a nepřijatá autorita nejsou oprávněním.
- Po skutečném local purge a simulovaném přerušení global checkpoint
  transakce se skutečný řadič restartuje. Nový Driver proof získá pouze
  GET; neobnoví inventář odstraněných dnů a neodešle nový POST.
- Sdílené SIM/IZS a Keycloak jsou mimo zvolený rozsah. Celý účet ani
  zálohy test neoznačí za odstraněné.

V controller testu jsou stores, OIDC actor/identity review, nativní
admission, publication barrier a ostatní vlastníci syntetičtí. Veřejné
COP HTTP routes/login, frontend, iPhone, native PostgreSQL a skutečný
Root/restore nejsou tímto během ověřené. Model/provider/matcher i
zakázané síťové volání mají počet nula.

V peer testu všech deset authority flags zůstává false. Historical ACK
není nové admission a timeout není abort, settlement ani drain. Čtyři
neukončené výměny drží kapacitu až do skutečného ukončení; pozdní odpovědi
neobnoví CAS. Negativní production bridge je nekompatibilní. Nejde o
nativní transport ani o implementaci připravované jiné verze protokolu.

## Historické a infrastrukturní důkazy jsou oddělené

Původní [10 scénářů/71 HTTP a 41 PostgreSQL kontrol](2026-10-14_COP_SIM_ERASURE_HTTP_CORRECTION.md)
pro COP `a0c6fd6` se nepřepisují ani nepřičítají k novému controller běhu.
Původní runner má stále SHA-256
`666a4a06ae28ded9824884224c8246a7a3658c334fa297f88c7e9b729e45831b`.
Rootových 40 historických offline wrapper testů se nepřičítá k 61
klientským testům.

SIM zkontroloval obsah a hash samostatných infrastrukturních receipt:

- Prázdná guard metadata DB, devět prázdných tabulek a sedm NOLOGIN rolí;
  bez enrollment, nového LOGIN, klíčů, služby nebo aplikační migrace.
- Devět skutečných vlastních Linuxových fixture případů provedených
  správcem v jednorázovém neprivilegovaném kontejneru bez sítě a host
  bind mountu; úklid vlastních procesů i kontejneru potvrzen.

SIM tento Linuxový běh neopakoval. V2 kernel harness není šestimetodový
owner-wire klient v1. Pre/post procesové snapshoty nejsou atomické
runtime generation/externí COMMIT/fence pořadí. Guard metadata DB není
aplikační fence store ani proof pro obyčejný COP chat.

## Zbývající produkční gate

1. Konkrétně přijatá a zřízená chráněná Root authority s trvalým admission,
   commit/fence pořadím, známým readback a pravidly pro pending výsledek.
2. Přesný private runtime/peer kontrakt a skutečný bootstrap stávajících
   aliasů, driver retained/outbox dnů a všech klíčových verzí. Žádná
   automatická adopce hashů nebo trvalá vazba účet–den v SIM.
3. Owner-wide replay bez mezer, generation pro souhrnná čtení/publikaci,
   maintenance a nezávislá karanténa obnovy všech kopií.
4. Skutečné společné acceptance proti této autoritě a omezeným rolím,
   před změnou produkčních obrazů a před aktivací mazání.

Návrh zpevnění PostgreSQL local `trust` na `peer` je samostatný
infrastrukturní source plán; HBA nebyla měněna. Jeho konkrétní preapply
kontroly, změna, reload a rollback nejsou součástí SIM migrací 002/003.
SIM kvůli těmto testům neměnil produkční obraz, aplikační DB, secrets,
síť, chat, příjem Jízdy, rychlosti ani ETA. Žádný skutečný účet nebyl
testovacím mazáním odstraněn. Nový Router obraz se nesmí před autoritou
nasadit pouze s erasure flagem false: jeho ochranná brána by blokovala
i dosavadní COP chat.
