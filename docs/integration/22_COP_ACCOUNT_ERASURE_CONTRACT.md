# Mazání účtu COP v SIM

Stav: implementační kontrakt v1; upřesnění ze 14. 10. 2026.
Zdrojová implementace a omezené migrace byly výslovně schváleny. Nasazení
je oddělené od aktivace a od důkazu smazání účtu. Inventura běžných
úložišť vychází z revize SIM `03b842e` a identity COP z `3be10da`.

Machine-readable fragment je v
[`openapi/fragments/account-erasure-v1.openapi.json`](../../openapi/fragments/account-erasure-v1.openapi.json).
Závazný kontrakt generuje `openapi/openapi.json`. Dostupnost operace určuje
aktuální `capability`, nikoli dokument, healthcheck nebo konfigurační flag.

## Zachovaný společný účet a SIM

Tento životní cyklus odstraňuje pouze COP/Jízdu. Společná Keycloak identita,
přístup do SIM, SIM/IZS namespace, projekty a jejich finanční historie
zůstávají mimo rozsah. Neprovádí se globální logout ani DELETE sdíleného
uživatele. Router potvrzuje `aliasScope=sim_izs_preserved_out_of_scope`.
Zachování těchto dat je zvolený rozsah, ne blocker smazání COP/Jízdy.

COP koordinuje zánik účtu a jednotlivé backendy potvrzují pouze svůj
rozsah. Stav 202 musí uživatel vidět jako probíhající mazání. Dokončení
jednoho dne měření nebo odstranění AI klíče neznamená dokončení celého účtu.

## Současná úložiště a skutečná retence

| Úložiště | Vazby na účet | Současné chování a vlastník |
| --- | --- | --- |
| `driver_measurement_receipts` | Denní HMAC, HMAC UUID a digest, receipt | SDA: expirace sedm dní od přijetí; běžící store čistí po minutě. |
| `driver_measurement_intervals`, `driver_measurement_eta` | Odvozené hrany, okna a omezená ETA, vazba na receipt | SDA: FK cascade při odstranění receipt; žádné sloupce raw GPS. |
| `driver_measurement_revocations` | Denní HMAC | SDA: sedmidenní ochrana proti pozdnímu commitu stejného pseudonymu. |
| Scalar `latest.json` | Budoucí odvozené souhrny bez jednotlivých identit | Není součástí zdrojového základu `03b842e`; případné samostatné nasazení reportu vyžaduje inventuru writerů a ochranu souběžné publikace. Absence writeru ve zdroji není důkazem absence externí kopie. |
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
tvrzení. Navržený `x-cop-actor` je UTF-8 JSON bez mezer v přesném pořadí
`iss`, `sub`, `aud`, `iat`, `exp`, `operationId`, `routerUserId`, zakódovaný
canonical base64url bez paddingu. Neznámá, opakovaná nebo chybějící pole
jsou neplatná. `iss` se přesně shoduje se samostatně schváleným issuerem;
`sub` je neprázdný subject ověřené relace COP, nejvýše 512 znaků bez
řídicích znaků. `aud` je `sim-account-erasure`. Celočíselné Unix časy
musí splnit `iat <= now < exp` a `0 < exp - iat <= 60`; ID operace se
musí shodovat s tělem nebo cestou. `x-cop-actor-signature` je malými hex
znaky HMAC-SHA256 přesné encoded hodnoty. Příslušný dedikovaný COP bearer
zůstává povinný. Podpis pro `sim-ai-router` se pro mazání odmítá.

`routerUserId` se na serveru COP odvodí **stejnou existující funkcí** jako
ordinary BYOK `actor.sub` a legacy COP chat `userId`:

```text
routerUserId = "cop_" + base64url(HMAC-SHA256(
  existingCopUserIdSecret, "cop-router-chat-v1" + NUL + verifiedSessionSubject
))
targetUserHash = existingBudgetStore.hashUser("cop", routerUserId)
```

Vazba nové mazací operace na `iss` a `sub` je oddělená od cílového
`targetUserHash`. Přímé hashování raw subjectu nebo nového erasure aliasu
by hledalo jiný namespace a mohlo by falešně potvrdit nulový nález.
Dosavadní derivace Router identity neobsahuje issuer; propojení proto
vyžaduje doložení stávajícího issueru a všech použitých derivací/klíčových
verzí. Neznámá historická identita znamená blokované preflight review,
nikoli vytvoření nové identity nebo potvrzení smazání. SIM/IZS aliasy
zůstávají oddělené. Běžný čtyřpolový BYOK actor se tímto návrhem nemění.

Prohlížeč nesmí určovat cílovou identitu, plátce, pseudonymy, hlavičky
služby nebo URL poskytovatele. Neznámé klíče, query a browser `Origin`
se odmítnou. Raw subject, alias, manifest, podpis a tokeny se neukládají
do receipt ani nelogují; jsou pouze přechodným interním vstupem. Nový podpisový
účel a jeho distribuce do SDA jsou samostatný deployment review.

Server COP vytváří neprůhledné UUID `operationId` a zachovává je při
retry. Backend váže ID na HMAC účtu a neměnný digest těla. Jiný účet
nebo jiný manifest nesmí získat existující výsledek. Rotující `iat`,
`exp` a podpis nejsou součástí idempotency digestu.

## Interní operace

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
překročení nesmí znamenat tiché zkrácení. Tělo neobsahuje `keyVersion`,
proto SIM nemůže rozpoznat chybějící historickou verzi klíče. COP musí
úplnost verzí doložit před odesláním; neznámá verze blokuje preflight.

Pro společnou operaci používat serverově generované UUID v4. Driver
endpoint přijímá UUID verzí 1–5, což výslovně vynucuje také závazné
schéma požadavku, preflightu, receipt a parametru cesty. COP nesmí
pro Driver generovat širší UUID variantu jen podle Router validátoru.

COP sestaví celý možný retenční interval od `UTC-date(acceptedAt − 8 dní)`
po UTC den prvního přijetí v SIM a datum přípustné tolerancí budoucího
pozorování 30 sekund. `acceptedAt` uloží SIM při první operaci; COP navíc
zahrne všechny doložené dny svého retained/outbox inventáře. Opožděné
první doručení vyžaduje aktualizovat manifest před odesláním, ne opakovat
starý rozsah jako domněle úplný.
Zahrne všechny skutečně použité HMAC verze a retained/outbox dny. Při
opakování přes půlnoc se úplnost hodnotí proti původnímu přijetí operace,
nikoli novému času podpisu. SIM neumí samostatně prokázat příslušnost
neprůhledných denních pseudonymů k účtu; tuto skutečnost atestuje COP.

GET nemá vedlejší efekt zpracování fronty ani volání poskytovatele.
POST nebo explicitní interní worker obnoví trvalý čekající stav; nemají
neomezenou retry smyčku. 401/403, 400, 409, 429 a 503 jsou jednoznačné
hranice, nikoli důvod obejít SIM, obnovit starý klíč nebo volat OpenAI přímo.

## Readiness a preflight

Následující čtyři operace jsou čistě čtecí. Cesty v tabulce jsou relativní
k interní službě; v kompozitním kontraktu má SDA prefix `/situation-data`.
Router prefix navíc nemá. Vypnutý příjem měření není překážkou jejich
odvolání; vypnutá erasure capability nesmí vytvořit novou operaci.

| Vlastník | Metoda a cesta | Ověření a tělo |
| --- | --- | --- |
| `sim_measurements` | `GET /api/v1/internal/driver-measurements/v1/account-erasure-operations/capability` | Vyhrazený measurement bearer; bez actor hlaviček, těla a query. |
| `sim_measurements` | `POST /api/v1/internal/driver-measurements/v1/account-erasure-operations/preflight` | Stejný bearer, sedmipolový purpose actor a přesný `DriverErasureRequest` jako start. |
| `ai_router` | `GET /api/v1/ai-router/cop/users/me/erasure-operations/capability` | Vyhrazený Router bearer; bez actor hlaviček, těla a query. |
| `ai_router` | `POST /api/v1/ai-router/cop/users/me/erasure-operations/preflight` | Stejný bearer, sedmipolový purpose actor a přesný `RouterErasureRequest` jako start. |

Všechny probe odpovědi mají `Cache-Control: no-store`, UTC `checkedAt`,
`owner`, pojmenovaný `scope`, `enabled`, `ready`, přesně typované `checks`
a `blockers`. Vždy vracejí `mutates=false`, `providerCalls=false` a
`wholeAccountComplete=false`. `ready` je právě konjunkce zapnutí, všech
příslušných kontrol a schváleného retenčního/publikačního režimu; při
`ready=true` je seznam blockers prázdný, při `ready=false` je neprázdný.

Capability ověřuje skutečné schéma, omezená oprávnění, schválené identity,
aktuální chráněný restore checkpoint a retenci. U měření navíc vyžaduje
publikační ochranu a ověřený režim reportu. Zdravá služba, historické DB
`ready=true`, procesová epocha ani konfigurační přepínač tyto důkazy
nenahrazují. Obecná Router capability neobsahuje `providerRequestsSettled`,
protože bez actor identity nemá konkrétní účet.

Preflight kontroluje vlastní actor/operation vazbu a původní digest,
pokud už operace existuje. Přidává `identityBindingReviewed`; Router
ověří `providerRequestsSettled` pouze pro daný cílový účet. SDA dostane
celý manifest a přidá `manifestShapeAndCoverageValid`, `manifestValid=true`,
počet položek a `coverageAnchor={kind,at}`. `kind=checked_at` u nové
operace používá právě `checkedAt`; `kind=first_accepted_at` u existující
vlastní operace používá původní uložené `acceptedAt`. `manifestValid`
dokládá tvar a UTC rozsah, nikoli příslušnost pseudonymů nebo úplnost
historických klíčových verzí a outboxu; ty atestuje COP.

Interval devíti nebo deseti UTC dnů je povinné **minimum**, nikoli zákaz
starší historie. Manifest může v limitu 40 dvojic obsahovat další starší
retained/outbox dny a skutečně používané klíčové verze. Každý den musí být
platným UTC kalendářním datem a nesmí být pozdější než den původního
`acceptedAt + 30 sekund`. Chybějící povinný den, nepovolená budoucnost
nebo překročení limitu se odmítne; starší inventář se nikdy potichu neořízne.
Toto pravidlo nemění 24hodinové stáří příjmu ani sedmidenní retenci měření.
Po prvním přijetí zůstává celý manifest a jeho digest neměnný.

HTTP 200 zde znamená pouze spolehlivě provedenou kontrolu. `ready=false`
je blokovaná příprava, nikoli zahájené mazání; preflight nepoužívá 202.
Router omezuje tento namespace na 60 požadavků za minutu a nejvýše dvě
souběžné start/resume operace na proces. Překročení vrací 429 a
`Retry-After`. SDA používá stávající sdílený limit measurement služby
`DRIVER_MEASUREMENTS_RATE_PER_MINUTE` (výchozí 120). Jde o místní limity
procesu, nikoli tvrzení o distribuovaném limiteru všech replik.
Při nemožnosti kontrolu spolehlivě provést vrací 503. Nezapisuje operaci,
fence, rezervaci ani receipt, nedešifruje AI klíč a nevolá poskytovatele.
Cizí existující operace nemá odhalitelný stav; vrací stejné 404 jako
neviditelný záznam. 409 patří pouze konfliktu vlastní neměnné operace.

Výsledek preflight není trvalé oprávnění. Start znovu ověří všechny
podmínky pod skutečnými zámky, včetně nové in-flight práce nebo UTC
půlnoci mezi probe a prvním přijetím. Před přepnutím COP adaptéru zahrne společná akceptace konkrétní
implementaci, závazný kontrakt a oba interní adaptéry.

Router má výjimku pro právě běžící provider práci: při splnění všech
službových kontrol může POST přijmout ochrannou fence a vrátit 202
`provider_requests_pending`, přestože actor preflight má `ready=false`.
Tak zablokuje nové požadavky a výměnu klíče, dokud se původní práce
nevypořádá. Není to výjimka z oprávnění, identity, retence nebo autority
obnovy a není to potvrzení dokončení. Eraser poskytovatele nevolá.

## Důkaz dokončení a závody

HTTP 202 znamená například čekání na in-flight požadavek, nákladovou
politiku, replay záloh, report nebo kontrolu writerů. HTTP 200 potvrzuje
jen pojmenovaný online rozsah po databázovém ověření a potvrzení odvozených
kopií. Odpověď nikdy nevrací `wholeAccountComplete=true` ani dokončení
u poskytovatele nebo ve fyzických zálohách.

OpenAPI odděluje receipt schémata pro 200 a 202. Pending musí mít
důvod a nesmí tvrdit online dokončení Routeru. GET pro cizí i neexistující
operaci vrací totožné 404; konflikt neměnného těla vlastní operace patří
do POST 409 a nesmí prozradit cizí stav. Router používá
`erasure_processing_pending`, pokud je uložená operace stále pending,
ale již nejsou jiné blokující podmínky a transakční dokončení ještě
neproběhlo. GET ho nesmí dokončovat ani vymýšlet falešný retenční důvod.

Commit dávky a revokace zamykají stejné pseudonymy. Pozdní commit po
fence nesmí přidat řádek do agregace. Během AI mazání se zablokuje PUT,
getKey, reserve, BYOK chat i legacy COP generate; pozdní výstup se zahodí,
náklad se ale konzervativně zapíše. Samotné odstranění klíče z tabulky
nevynuluje jeho dříve dešifrovanou kopii v běžícím požadavku.

Více writerů reportu vyžaduje sdílenou transakční/generační ochranu,
nebo vynucený a doložený jediný writer. Bez tohoto důkazu je odpověď
čekající, i když v databázi nezůstaly příspěvky. Starý report ze zálohy
se před připojením readeru odstraní nebo zneplatní.

Receipt rozlišuje `reportProtection=unverified|no_report|enforced_single_writer|shared_generation_fence`
a `publicationFenceVerified`. `no_report` vyžaduje inventuru skutečně
nasazených i externích kopií, nikoli jen absenci modulu ve zdroji.
Dokončení vyžaduje skutečné potvrzení ochrany, replay a retenčního review;
procesová epocha ani samotný příznak review nejsou důkazem vynucení.

## Nákladová retence a otevřené retenční hranice

Vlastník dne 14. 10. 2026 výslovně schválil provozní nákladovou retenci
`aggregate-costs-current-month-v1`. Ta zachová pouze účetní větev, UTC den,
součet konzervativních nákladů, počet požadavků a vstupních/výstupních
tokenů. Nezachová account, payer či actor hash, request/operation ID,
fingerprint, obsah, uživatelskou skupinu ani join na operaci mazání.
Účelem je zabránit resetu běžných denních a měsíčních finančních stropů.

Expirace této minimalizované evidence je začátek dalšího UTC
měsíce po vypořádání všech rezervací relevantního období. Nevyřešené
`reserved`/`uncertain` nesmějí být vyúčtovány ani prohlášeny za smazané
jen podle času; správce musí schválit jejich konkrétní vypořádání a
maximální horizont. Schválení těchto součtů netvrdí jejich anonymitu při
malém počtu uživatelů ani neřeší kopie poskytovatele, zálohy a logy.

Runtime nesmí tuto politiku automaticky odvodit z přítomnosti schématu.
Bez jejího konkrétního owner-controlled potvrzení zůstává stav
`pending_requires_review`. Pokud by vlastník zachování součtů odmítl,
preflight je `ready=false` a nová operace se nesmí zahájit. Již existující
operace zůstává čekající do schválení jiné varianty zachovávající stropy.
Součty se nesmějí tajně ponechat ani vazby bez náhrady odstranit a tím
resetovat finanční limity.

Legacy sdílený finanční strop čte `ai_router_budget_usage` včetně převedených
součtů a platí i pro zachovaný SIM namespace. BYOK limit je dosud
na konkrétního plátce: erasure target zůstává trvale zablokovaný. Jeho
odvázaná historie je zahrnutá v celkovém přehledu SIM, ale nesmí se
přičítat limitu jiného uživatele s vlastním OpenAI klíčem. `sim_project`
větev a její rozpočet zůstávají oddělené a zachované.

Omezené runtime DML vlastník přímo schválil 14. 10. 2026. Migrace
`deploy/ai-router/003_account_erasure.sql` přidává RLS omezené DELETE
navázané COP historie a oddělené minimální finanční součty. Migrace
`deploy/driver-measurements/002_account_erasure.sql` přidává skalární
ledger a trvalé denní fence bez vazby účet → dny. Runtime nemá DDL,
superuser, bypass RLS ani UPDATE owner checkpointu. Funkce jsou
`SECURITY INVOKER`; běžné sedmidenní čištění fence nemaže.

Samostatné rozhodnutí vlastníka musí určit také horizont minimálního
replay tombstone, erasure receipt, všech záloh/WAL a logů. Historické
SIM/IZS aliasy, volné operátorské review důvody a sdílené scénáře
zůstávají záměrně mimo zvolený rozsah COP/Jízdy. Nesmějí se spojovat
nebo plošně mazat. Kopie COP u poskytovatele a v zálohách zůstávají
samostatnou retenční hranicí; nepatří do online receipt.

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

Jednotkové, HTTP a izolované PostgreSQL testy používají pouze syntetické
identity a falešné poskytovatele. Výsledek produkční a společné akceptace
se musí zaznamenat zvlášť; žádný test nemaže skutečný účet nebo volá OpenAI.

## Napojení na chráněnou nativní autoritu

Konkrétní současné operation/body/schema vazby, runtime porty a souborový
plán dalšího kroku jsou v [integraci 23](23_SIM_ACCOUNT_SAFETY_RUNTIME_PREPARATION.md).
Její neaktivní instalační inventář nemá install/start/migrate actions ani
produkční oprávnění; V5 se do aplikací neimportuje.

Zdrojová kontrola SIM `fe0eec5` potvrzuje chybějící runtime propojení,
nikoli hotového klienta brokeru. Router předává do `PgAccountErasure`
výchozí verifier `false`; SDA registruje Driver bez protected-proof a
derived-barrier dependencies. Omezený databázový základ infrastruktury
je zřízený, ale jeho existence, health, JWS snapshot ani lokální checkpoint
nepovolují operaci. Přenosový kontrakt Linux wrapperu musí nejprve určit
request i response schémata, framing, meze, peer/runtime ověření a retry.

Pevné mapování je `sim_ai_router → ai_router / cop_router_primary_database`
a `sim_driver_measurements → sim_measurements / online_driver_scope`.
Nejsou to názvy databází ani volitelné cíle klienta. Nová ochrana se
vztahuje na COP/Jízdu; `client_id=sim`, `sim_project`, IZS a společná
identita/relace/oprávnění zůstávají mimo toto mazání.

### Potřebná volání a přesná místa

Názvy v prostředním sloupci jsou navržené private metody infrastruktury,
nikoli existující REST endpointy. Poslední dva řádky vyžadují samostatné
owner-wide typy, které nynější per-principal návrh nepokrývá.

| Spotřebitel ve zdroji | Požadovaná private hranice | Životnost a výsledek |
| --- | --- | --- |
| Router `capability`, Driver `gate`; oba entrypointy | Čtecí current-proof/enrollment probe | Skutečný runtime, owner store, schema/policy a souvislý frontier; bez actor fence nebo mutace. |
| Router key GET/PUT/DELETE, rezervace a dispatch; Driver lookup/matcher/commit/revoke | `resolveOwnerEvidence` → `admitGuardedOperation` | Samostatný schválený principal reference, přesný účel a ID práce; žádný admission podle pouhého hash nebo SQL booleanu. |
| Oba SQL store commity a skutečné externí handoffy | `beginGuardedCommit` | Registrovaná gate serializovaná s permanent fence a držená přes skutečný commit i rozpracované vedlejší efekty. |
| Oba Router `finish`, Driver commit/abort, pozdní výsledky | `completeGuardedOperation` | Typované, nezávisle rozřešené terminal evidence z přijaté práce; timeout není abort. Settlement zůstává možný po fence, nový dispatch/výstup nikoli. |
| Router `request/advance`, Driver `erase/acknowledge` | Root `commitPermanentFence` → `readOwnerDrain` → `readPrivateOwnerReadback` | Trvalá fence před dokončením cleanupu; skutečný drain a generačně svázané readback/report potvrzení. SIM nemá root fence oprávnění. |
| Driver `aggregates/quality`, report/cache/publication | Owner/dataset-wide read a publication generation | Každá relevantní fence zneplatní staré výsledky. Per-principal drain neprokazuje odvodnění všech souhrnných čtení. |
| Driver cleanup, Router rollup expiry, startup/replay | Owner-wide maintenance a souvislý replay | Bez smyšleného uživatelského principalu; zahrnout completed i pending fence, neapplicable události a aktuální CAS. |

Čtecí checkpoint verifier nenahradí `admit` ani commit gate. Současný
`AccountErasureGate.assertActive(targetHash, transaction?)` nezná účel,
request ID, lease ani outcome. Driver proof nezná principal/operaci,
aktuální incarnation/frontier ani lease; `DerivedBarrier(): Promise<void>`
nezná manifest, generaci ani typované potvrzení. Tyto interfaces musejí
být rozšířené podle přijatého native protokolu, ne napojené na callback,
který vrátí `true` podle podpisu, TTL nebo přítomnosti metadata DB.

Router PUT klíče v `separate-routes.ts` volá `validateProjectKey` před
uložením. Jde o externí `/models` side effect mimo současný reservation
ledger; jeho lease/drain musí existovat samostatně. Oba `finish()` získají
principal a lane z již přijatého trvalého requestu, ne od klienta nebo
z nové identity. Nejistý provider výsledek zůstává pending, bez resetu
finančních stropů či přímého fallbacku.

Driver `aggregates/quality` a publikace přesahují jednu identitu. Potřebují
owner-wide generaci platnou přes snapshot a response/publication boundary;
nesmí se pro ně vymyslet osobní `principalScopeRef`. Minutový cleanup a
expirace nákladových součtů mají oddělenou maintenance capability. Native
gate musí platit i po restartu a při obnovené prázdné/staré DB, ještě před
vznikem workeru a prvním chráněným čtením; `processPending()` není replay.

### Přenosová data a chybějící bootstrap

Nynější návrh `cop-private-admission-proposal-v1` je výslovně
`isolated-contract-only` / `unaccepted-proposal` / `productionAuthorization=false`.
Má exact request pole `requestId`, `requestNonce`, `method`, `audience`,
`operationId`, `principalScopeRef`, `binding`, `ownerTarget`,
`operationSchemaDigest`; dále typed `ownerEvidence`, `cas`, `lease`,
`commitPermit`, `terminalEvidence` podle metody. Root musí nezávisle
rozřešit identity/retention/report/schema refs, aktuální frontier,
store/incarnation a registry generation. Shape-valid reference není důkaz.
Skutečný klient nemá implementovat zatím chybějící response či transport.

Běžný BYOK actor obsahuje původní opaque alias, ne raw subject pro
sedmipolový erasure actor. Driver intake v1 obsahuje denní pseudonym a
službový bearer, ne ověřený účet. Broker proto potřebuje přesný nezávislý
bootstrap existujícího aliasu/denního scope do přijatého operation reference.
COP ani SIM nesmějí tento reference vytvořit automatickou adopcí hashů.
Případná serverová native envelope nesmí měnit přesné tělo
`sim-driver-measurements-v1` nebo z něj vytvořit účetní identifikátor.

Do private přenosu nepatří prompt, AI klíč, plaintext komunikace, surové
GPS, příloha, fingerprint ani volný kontext. Owner manifest a odvozené
contributor hashes zůstávají pouze ephemeral podle schváleného identity
resolveru. V Driver SQL nevznikne trvalý join účet → dny. Registry key,
root role nebo Docker socket nesmějí být mountnuté do SIM.

Před implementací klienta musí infrastruktura dodat přesný response/error
kontrakt, autentizovaný peer/runtime binding, challenge/nonce a aktuální
CAS, bounded frame/response velikost, timeout a crash/reconnect protokol.
Reference expiry omezuje nové použití, ale nikdy sama neodvodní lease,
nesmaže fence ani nevytvoří known-terminal abort.

### Ověření klienta před propojením

Negativní testy zahrnou chybějící socket/enrollment/identity, nesprávný
peer/owner/image/policy/incarnation, starý či replayed nonce/proof a N+1
frontier. Ověří fence během key validation, matcheru, lookupu, rezervace,
dispatch a bezprostředně před COMMIT; pád mezi commitem a native ack;
unknown provider outcome a nemožnost návratu pozdního výstupu. Souhrnné
čtení či druhý writer nesmí po drain zveřejnit starou generaci. Současně
ověřit maintenance/replay, zachování SIM/IZS, shadow režimu a finančních
stropů. Tyto budoucí native scénáře nejsou součástí již doložených 10 HTTP
a 41 PostgreSQL kontrol; žádný pozitivní fixture nenahrazuje aktuální broker.

### Izolovaný testovací protokol v1

Infrastruktura dodala oddělený fixture protokol
`cop-actor-peer-isolated-v1`, nikoli produkční variantu předchozího
`cop-private-admission-proposal-v1`. Jeho mode je výhradně
`isolated-fixture-only`. Request má šest přesných klíčů `protocol`,
`mode`, `owner`, `requestId`, `method`, `args`. Obsahuje pouze metody
`current`, `admit`, `begin_commit`, `complete`, `mark_indeterminate`,
`drain`; nenabízí enrollment, registraci identity/evidence, fence,
cleanup, skutečný local commit, provider dispatch ani settlement.

Wrapper je zmrazený na SHA-256
`64e26614bf4512157f09281e0fed7452bdd0c327a6e3f807059a062f027bd69b`,
request schema na
`ed06fbb3b460bd6ba7bc3a48369d90c0944677dce7b7577dc5a3aac0d35aee3e`
a coordinator na
`5da047bd04aaf3766a3b8ce2572b2ee8eaa38e8439d8462ed277e342a748e01e`.
Nový wrapper/protocol vyžaduje samostatnou revizi. V1 nelze označit za
kompatibilní s připravovaným v2 nebo za Linux kernel akceptaci.

Testovací klient smí používat jen explicitně injektovanou výměnu packetů
v paměti, bez nativního transportu a bez produkčního entrypointu. Rámec
je nejvýše 16 384 UTF-8 bajtů; parser odmítá duplicate keys ve všech
hloubkách, druhý JSON dokument, neplatné UTF-8, všechny float lexémy
včetně `1.0` a `1e0`, nefinite a unsafe integers. Nested CAS, lease a
čtyři evidence refs mají přesný tvar a jsou pouze fixture reference.

Response nemá top-level owner ani method. Result se váže na původní
request/method, předem určený owner a fixture binding, shodný requestId,
izolovaný response mode a scope 3. Všech deset authority flags musí být
přítomných a `false`; ani validní CAS, `drained` nebo terminal ACK
neznamená produkční připravenost. `requestId` je korelace, ne idempotentní
oprávnění. Historical ACK nemůže vydat nové admission/commit oprávnění.

Wire error envelope v1 není definovaný. Chybné bytes, zavřená výměna,
Denied, timeout či pozdní výsledek nemohou být known abort nebo settlement.
Deadline klienta ukončuje jen jeho čekání; neprokazuje ukončení serveru,
není backend watchdog a nevytváří automatický retry či příkaz k cleanupu.
Fixture klient se nesmí připojit jako `OwnerCheckpointVerifier` nebo
`DriverErasureProtectedProof`; production compatibility zůstane `false`.
Skutečný owner-wide replay/generation, principal bootstrap, runtime trust
a distribuované vypořádání zůstávají mimo tento izolovaný protokol.

Zdrojový klient je pouze `scripts/lib/isolated-native-peer-client.mts`;
žádný `apps/*/src` jej neimportuje. `scripts/test-isolated-native-peer-client.mts`
ověřuje přesné externí source piny před importem, nezávislé Ajv2020 schema
a deterministické výměny v paměti. Samostatný negativní bridge vždy vrací
`compatible:false`, `productionReady:false` a
`ISOLATED_PROTOCOL_NOT_RUNTIME_AUTHORITY`. Čtyři neukončené výměny obsazují
kapacitu i po timeoutu; pozdní odpověď nezaloží current CAS ani oprávnění.
Test nesmí být zapojen do runtime, použit jako pozitivní proof nebo
přejmenován na Linux akceptaci.

### Oddělený offline kontrakt V5

`cop-dormant-boundary-fixture-v5` je nový, výhradně testovací kontrakt
`own-fixture-only`. Nenahrazuje zmrazený v1, nepřejmenovává výsledky v4
a není přijatým produkčním wire protokolem. Python boundary má SHA-256
`f0bffe6f0f6d3b26570050c2a0bcb59d27923e3a347f8967b9aba76240a859dd`;
jeho `SOURCE-PINS.json` má
`90814725db2f78232d401fbdf83f6f5d99a16a146b67e648adfb76d4d018523f`.

Request obsahuje přesně `protocol`, `mode`, `requestId`, `bindingDigest`,
`method`, `operation`, `args`. `operation` obsahuje pouze `operationId`,
`bodyDigest`, `schemaDigest`, `operationCode`. Metody jsou `current`,
`admit`, `begin_commit`, `unknown`, `settle`, `drain`. Pevný operation a
binding určuje konfigurace testu, nikoli vlastník, socket, účet nebo
oprávnění zaslané ve volném payloadu. Caller CAS má přesně osm polí;
`scopeRef` musí odpovídat `operationId`. Registry digests lease a permitu
jsou opaque: nejsou frame hash a klient z nich nemůže odvodit autoritu.

Úspěšná odpověď se kontroluje proti původnímu requestu včetně method,
bindingu, canonical frame a correlation digestu. Všech jedenáct přesných
authority flags musí být `false`. `admit.ack` odpovídá historical markeru,
`begin_commit.permit.leaseId` odpovídá požadované lease a `drain.scope`
odpovídá actor/owner operation code; `pending` musí souhlasit se stavem.
Marker historical, syntetické drained ani ACK neopravňují k novému
admission, cleanupu nebo externímu efektu. Příslušnost lease, původ refs,
skutečný grant a fence může ověřit jen registrující autorita, ne tento DTO.

V5 také odděluje nové admission od vypořádání původního efektu. Nově
registrovaný origin kanál může podle serverového grant scope použít
`current`, `unknown`, `settle`, `drain`, aby po doloženém původním
settlementu získal aktuální CAS. To neuděluje `admit` ani `begin_commit`
pro cizí/starou generaci. Přijatý immutable permit je původní autorizační
hranice; nelze k ní dodatečně přidat automatický abort podle smrti procesu
nebo tvrdit nepřerušenou živost stejného executable napříč externím COMMIT.

Rámec je 1–16 384 UTF-8 bajtů, bez BOM, duplicate keys, trailing JSON,
float/exponent lexémů, nonfinite, unsafe integer a unpaired surrogate.
Limity jsou hloubka 12 (root 0), 256 uzlů, pole 32, klíč 64 a string 256
Unicode code points. Canonical bytes validovaných ASCII DTO používají
řazené klíče a Python `ensure_ascii` escaping; nejde o obecné Unicode JCS.
Chyba má pevný denied-or-unknown envelope. Null, chybně korelovaná nebo
malformed odpověď, výpadek a deadline zůstávají unknown-not-settled.

`scripts/lib/dormant-fixture-json.mts` je společná čistá JSON mechanika,
nikoli validátor identity nebo protokolu. V5 validátor a klient jsou v
`scripts/lib/dormant-v5-fixture-client.mts`. Klient přijímá jen explicitní
testovací výměnu packetů, drží nejvýše čtyři rozpracované výměny až do
skutečného ukončení jejich promises a nemá automatický retry či settlement.
Žádný aplikační entrypoint jej neimportuje; negativní bridge vrací pouze
`compatible:false` a `productionReady:false`.

### Návrh nejmenšího nativního transportu pro Node

Offline companion a skutečný transport jsou oddělené komponenty.
Základní `node:net` poskytuje streamové IPC, nikoli packetový API, které
by beze změny realizovalo zde požadovaný SEQPACKET kontrakt.
[Dokumentace Node 24](https://nodejs.org/docs/latest-v24.x/api/net.html#class-netsocket).
Linux `SOCK_SEQPACKET` zachovává hranice a pořadí zpráv. `SO_PASSCRED`
poskytuje credentials odesílatele při příjmu zprávy; `SO_PEERCRED` popisuje
credentials při vzniku spojení. Samotná kontrola spojení proto nenahradí
kontrolu skutečného odesílatele po předání deskriptoru.
[Linux unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html).

Pro budoucí implementaci navrhujeme malý in-process Node-API addon s
Linux `socket/sendmsg/recvmsg`, pevně vybraným owner kanálem a přesnými
packetovými limity. Odesílání z procesu Node zachová jeho skutečnou
kernelovou identitu; samostatný helper by byl jiným odesílatelem a
vyžadoval by vlastní přijatou proxy/operation registraci. Node-API nabízí
stabilní C rozhraní pro addon, ale binární sestavení potřebuje samostatně
připnutý toolchain a review.
[Node-API pro Node 24](https://nodejs.org/docs/latest-v24.x/api/n-api.html#node-api).
Jde o návrh, ne nainstalovanou závislost nebo přijatou provozní identitu.

| Varianta | Posouzení v tomto návrhu |
| --- | --- |
| In-process Node-API a SEQPACKET | Nejmenší přímá varianta zachovávající proces odesílatele a packetový kontrakt; potřebuje vlastní zdrojové, binární a skutečné Linuxové testy. |
| Oddělený pomocný proces | Může realizovat SEQPACKET, ale jeho PID/credentials nejsou původní Node actor. Přijetí helperu ani tvrzení rodiče nevytváří automaticky oprávnění aplikace. |
| Čistý `node:net` STREAM | Není náhrada hotového SEQPACKET API. Nový framing a nativní evidence zpráv by vyžadovaly vlastní protokol a testy; pouhý JSON prefix či SO_PEERCRED nestačí. |

Native komponenta nesmí přijímat owner, socket path, UID, image nebo
oprávnění z klientského payloadu. Přijatý producer ověřuje každou zprávu
proti pevné runtime/operation registraci; metadata procesu nejsou důkaz
vlastnictví soukromých dat. Nečekané SCM_RIGHTS, truncation nebo neznámé
ancillary data se odmítnou a každý skutečně přijatý FD se nezávisle zavře.
Žádné předávání FD nebo svévolných systémových volání se nevystaví do JS.
Pozdní odpověď a timeout zůstávají unknown, bez retry či inferred settlement.

Před skutečným napojením musí projít vlastní neprivilegovaný Linuxový
fixture se změnou odesílatele po předání FD, chybnými credentials,
truncation/FD cleanup, pádem peeru a čekající operací po přijatém permitu.
In-process transport sám nepotvrzuje bootstrap, owner refs, nezávislý
anchor, výsledky externích efektů ani obnovu. Nový offline klient zůstane
bez app importu, transportu a pozitivního verifieru; zmrazený v1 klient
ani jeho 61 testů se nepřepíšou výsledky jiné verze.

## Pokyn pro COP

Udržte account lock, send generation a durable erasure frontu nezávisle
na odstranění profilu. Manifest odvozujte výhradně na serveru, ne v klientu.
Adaptér zapněte až po společném review konkrétní revize OpenAPI, identity
a podpisových scopes, omezených grantů, retenčního rozhodnutí a restore
postupu. Odpověď 200 jednoho backendu nikdy nepovyšujte na dokončení celého
účtu; logy, poskytovatelovy kopie a zálohy zobrazte jako přesně vymezený stav.
Zachovanou identitu a SIM/IZS neoznačujte jako selhání mazání COP/Jízdy.
