# Mazání účtu COP v SIM

Stav: návrh kontraktu a retenčních hranic pro review; nové operace nejsou
produkční capability. Inventura vychází z revize SIM `ff5dc97`.

Machine-readable návrh je v
[`openapi/proposals/account-erasure-v1.openapi.json`](../../openapi/proposals/account-erasure-v1.openapi.json).
Není připojen do závazného `openapi/openapi.json`; popsané nové cesty nejsou
nasazeným ani ověřeným rozhraním. Přesun do závazného kontraktu vyžaduje
dokončenou implementaci, testy a výslovný review rozsahu.

COP koordinuje zánik účtu a jednotlivé backendy potvrzují pouze svůj
rozsah. Stav 202 musí uživatel vidět jako probíhající mazání. Dokončení
jednoho dne měření nebo odstranění AI klíče neznamená dokončení celého účtu.

## Současná úložiště a skutečná retence

| Úložiště | Vazby na účet | Současné chování a vlastník |
| --- | --- | --- |
| `driver_measurement_receipts` | Denní HMAC, HMAC UUID a digest, receipt | SDA: expirace sedm dní od přijetí; běžící store čistí po minutě. |
| `driver_measurement_intervals`, `driver_measurement_eta` | Odvozené hrany, okna a omezená ETA, vazba na receipt | SDA: FK cascade při odstranění receipt; žádné sloupce raw GPS. |
| `driver_measurement_revocations` | Denní HMAC | SDA: sedmidenní ochrana proti pozdnímu commitu stejného pseudonymu. |
| Scalar `latest.json` | Odvozené souhrny bez jednotlivých identit | SDA writer / SIM reader: po mazání invalidace nebo nový report; nutná ochrana souběžné publikace. |
| `ai_router_user_key` | COP user hash, šifrovaný klíč, nonce, tag, fingerprint a časy | Router: DELETE odstraňuje pouze tento řádek; bez TTL. |
| `ai_router_user_key_audit` | User hash, fingerprint, akce a čas | Router: bez TTL nebo cleanup; současný runtime má INSERT, ne DELETE. |
| `ai_router_request` | Client namespace, user hash, request ID, model, tokeny a náklady | Router: bez TTL; časové filtry spotřeby fyzicky nemažou historii. |
| `ai_router_billing_request` | Payer/actor hash, request ID, fingerprint, projekt, tokeny a náklady | Router: bez TTL; runtime nemá DELETE. Reserved/uncertain vyžadují vypořádání. |
| `ai_router_policy*` | Globální politika a její změny | Router: není automaticky součástí mazání jednoho účtu. |
| `sim-audit.jsonl` | Actor může být username/email/name; correlation a resource IDs | SIM: append-only, bez aplikační TTL či whole-account cleanup. |
| `sim-store.json` | Scénáře, návrhy a volné review důvody, request IDs | SIM: bez TTL a bez univerzálního spolehlivého ownership klíče. |
| OTEL, proxy/container/system logy, WAL a zálohy | Mohou obsahovat síťové a request metadata | Infrastruktura: přesný horizont a erasure/restore postup nejsou určeny aplikačním kódem. |

Současný Router neukládá prompty a odpovědi do účtovacích tabulek. To
neřeší jejich případné uchování poskytovatelem. Šifrování, hashování,
pseudonymy a prahování souhrnů samy nejsou důkazem anonymizace.

## Identita a službová hranice

Pouze COP API může odvodit účet ze své ověřené relace a vytvořit interní
tvrzení. Navržený `x-cop-actor` je canonical base64url JSON s přesnými
poli `sub`, `aud`, `iat`, `exp`, `operationId`; `aud` je
`sim-account-erasure`, `sub` má 8–128 znaků `[A-Za-z0-9_-]`, platnost je
nejvýše 60 sekund. `x-cop-actor-signature` je malými hex znaky HMAC-SHA256
přesné encoded hodnoty. Příslušný dedikovaný COP bearer zůstává povinný.
Podpis pro `sim-ai-router` se pro mazání odmítá.

Prohlížeč nesmí určovat cílovou identitu, plátce, pseudonymy, hlavičky
služby nebo URL poskytovatele. Neznámé klíče, query a browser `Origin`
se odmítnou. Podpis a tokeny se neukládají ani nelogují. Nový podpisový
účel a jeho distribuce do SDA jsou samostatný deployment review.

Server COP vytváří neprůhledné UUID `operationId` a zachovává je při
retry. Backend váže ID na HMAC účtu a neměnný digest těla. Jiný účet
nebo jiný manifest nesmí získat existující výsledek. Rotující `iat`,
`exp` a podpis nejsou součástí idempotency digestu.

## Navržené interní operace

| Backend | Operace | Rozsah |
| --- | --- | --- |
| SDA | `POST /api/v1/internal/driver-measurements/v1/account-erasure-operations` | Zahájení nebo obnovení stejné operace nad serverovým denním manifestem. |
| SDA | `GET …/account-erasure-operations/{operationId}` | Čisté čtení trvalého stavu vlastního účtu. |
| AI Router | `POST /api/v1/ai-router/cop/users/me/erasure-operations` | Lifecycle fence, odstranění klíče a postup mazání COP namespace. |
| AI Router | `GET …/erasure-operations/{operationId}` | Čisté čtení trvalého stavu stejného účtu. |

Router tělo obsahuje pouze `contractVersion=sim-account-erasure-v1`
a `operationId`. SDA navíc dostane `contributors` s přesnými dvojicemi
`contributorDay`, `contributorIdDay` a atestaci
`cop-account-erasure-contributors-reviewed-v1`. Limit je 40 dvojic;
překročení ani neznámá klíčová verze nesmějí znamenat tiché zkrácení.

COP sestaví celý možný retenční interval od `UTC-date(deleteAt − 8 dní)`
po dnešek a datum přípustné tolerancí budoucího pozorování 30 sekund.
Zahrne všechny skutečně použité HMAC verze a retained/outbox dny. Při
opakování přes půlnoc se úplnost hodnotí proti původnímu přijetí operace,
nikoli novému času podpisu. SIM neumí samostatně prokázat příslušnost
neprůhledných denních pseudonymů k účtu; tuto skutečnost atestuje COP.

GET nemá vedlejší efekt zpracování fronty ani volání poskytovatele.
POST nebo explicitní interní worker obnoví trvalý čekající stav; nemají
neomezenou retry smyčku. 401/403, 400, 409, 429 a 503 jsou jednoznačné
hranice, nikoli důvod obejít SIM, obnovit starý klíč nebo volat OpenAI přímo.

## Důkaz dokončení a závody

HTTP 202 znamená například čekání na in-flight požadavek, nákladovou
politiku, replay záloh, report nebo kontrolu writerů. HTTP 200 potvrzuje
jen pojmenovaný online rozsah po databázovém ověření a potvrzení odvozených
kopií. Odpověď nikdy nevrací `wholeAccountComplete=true` ani dokončení
u poskytovatele nebo ve fyzických zálohách.

Commit dávky a revokace zamykají stejné pseudonymy. Pozdní commit po
fence nesmí přidat řádek do agregace. Během AI mazání se zablokuje PUT,
getKey, reserve, BYOK chat i legacy COP generate; pozdní výstup se zahodí,
náklad se ale konzervativně zapíše. Samotné odstranění klíče z tabulky
nevynuluje jeho dříve dešifrovanou kopii v běžícím požadavku.

Více writerů reportu vyžaduje sdílenou transakční/generační ochranu,
nebo vynucený a doložený jediný writer. Bez tohoto důkazu je odpověď
čekající, i když v databázi nezůstaly příspěvky. Starý report ze zálohy
se před připojením readeru odstraní nebo zneplatní.

## Retenční rozhodnutí k samostatnému schválení

Výchozí stav je `pending_requires_review`. Návrh
`aggregate-costs-current-month-v1` zachová pouze účetní větev, UTC den,
součet konzervativních nákladů, počet požadavků a vstupních/výstupních
tokenů. Nezachová account, payer či actor hash, request/operation ID,
fingerprint, obsah, uživatelskou skupinu ani join na operaci mazání.
Účelem je zabránit resetu běžných denních a měsíčních finančních stropů.

Navržená expirace této minimalizované evidence je začátek dalšího UTC
měsíce po vypořádání všech rezervací relevantního období. Nevyřešené
`reserved`/`uncertain` nesmějí být vyúčtovány ani prohlášeny za smazané
jen podle času; správce musí schválit jejich konkrétní vypořádání a
maximální horizont. Tento návrh není přijatou právní retenční politikou
a netvrdí anonymitu při malém počtu uživatelů.

Samostatné rozhodnutí vlastníka musí určit také horizont minimálního
replay tombstone, erasure receipt, všech záloh/WAL a logů. Historické
SIM/IZS aliasy nelze automaticky spojovat s účtem COP. Volné operátorské
review důvody a sdílené scénáře se nesmějí plošně mazat bez ownership
pravidla. Dokud nejsou tyto části vyřešeny, jsou explicitním blockerem
dokončení celého účtu, nikoli domněle zahrnutým rozsahem.

## Akceptační scénáře

- Dvě syntetické identity: shodné ID cizího účtu, změněný manifest a
  neplatný/expirující purpose podpis se odmítnou bez prozrazení dat.
- Restart a retry přes UTC půlnoc zachovají jednu operaci a původní digest.
- Dávka čekající na matcher i pozdní idempotentní replay nepřidají po
  dokončené revokaci příspěvek; report ze druhé repliky nesmí obnovit snapshot.
- PUT klíče, rezervace a provider finish závodící s mazáním respektují
  lifecycle fence; žádný test nepoužívá skutečný klíč nebo OpenAI.
- Pending rezervace, neodsouhlasená retence a neověřená obnova vracejí 202;
  výpadek úložiště vrací 503, nikoli úspěch nebo přímý fallback.
- Převod finančních součtů je atomický a při retry se nezapočítá dvakrát;
  globální limity a přehled SIM zahrnují převod i zbývající navázané řádky.
- Obnovení staré DB/klíče/reportu zůstává v karanténě do replay aktuální
  autoritativní fronty COP; změna flagu ani starý obraz neobejdou fence.

Tyto scénáře jsou plánem ověření, nikoli dosud provedenými testy. Nové
capability, granty, tajemství a skutečné mazání zůstávají vypnuté.

## Pokyn pro COP

Udržte account lock, send generation a durable erasure frontu nezávisle
na odstranění profilu. Manifest odvozujte výhradně na serveru, ne v klientu.
Adaptér zapněte až po společném review konkrétní revize OpenAPI, identity
a podpisových scopes, omezených grantů, retenčního rozhodnutí a restore
postupu. Odpověď 200 jednoho backendu nikdy nepovyšujte na dokončení celého
účtu; nevyřešené aliasy, logy nebo zálohy zobrazte jako přesně vymezený stav.
