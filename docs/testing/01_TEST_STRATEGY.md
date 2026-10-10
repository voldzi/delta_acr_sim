# Test strategy

**Status:** Baseline dokumentace

## Úrovně testů

- unit testy validátorů a generátorů
- contract testy OpenAPI/JSON Schema
- integration testy publisheru a mock COP
- load testy event rate a queue
- AI guardrail testy
- UI smoke testy
- acceptance testy MVP scénářů

## Priorita

První implementační krok má testovat kontrakty, publisher safety gates a AI guardrails dříve než bohaté UI chování.

## Krizový mediální kontext a bezpečné kandidáty

Na podporovaném Node.js 24 a pnpm 10 spusťte hermetické testy Safety Data API:

```bash
pnpm --filter @csm-sim/safety-data-api test
pnpm --filter @csm-sim/safety-data-api typecheck
pnpm openapi:validate
bash scripts/validate-skeleton.sh
node scripts/test-deploy-crisis-context.mjs
node scripts/test-crisis-context-openapi.mjs
node scripts/test-crisis-gateway-deploy.mjs
bash scripts/smoke-nginx-crisis-freshness.sh
```

Konektorové testy musí prokázat default-disabled/no-fetch, pevný allowlist,
validaci query, atribuci, sanitizaci titulků, odmítnutí škodlivých odkazů,
nepřevzetí GPS/GeoRSS/enclosure a `eventAt=null`. Dále čas publikace ≤24 h,
odmítnutí budoucích/chybných/ambivalentních dat, relevantní vs. běžné,
retrospektivní a cvičné titulky, deduplikaci, limity metadata/body/nesting,
timeout fetch i body, coalescing query, cache TTL, backoff, explicitní stale,
expiraci/recovery a izolaci chyb jednotlivých feedů. Testy nesmějí volat
živé ČT24, články, AI nebo geokódování.

Notifikační testy musí odmítnout informativní/provider-denied prvky,
fallback/centroid body, obecné obecní RSS i geolokovanou neověřenou aktualitu.
Publikační datum nebo syntetická expirace nenahrazují explicitní aktivní event
interval. Zachovat autoritativní polygon a syntetické fixture, stabilní ID a
deduplikaci. Znovu prověřit `validUntil` při čtení cache a diagnostické
`includeStale=true`, které nesmí obejít eligibility/readiness.

Readiness testy rozlišují `ready`, `unavailable` a známým query limitem
`incomplete`: neplatný/starý/budoucí snapshot či cache čas, source warnings,
chyba bez pozdějšího úspěchu a stale úspěch. HTTP kontrakt ověří prázdné
kandidáty a `inputRejectedCount` při ne-ready vstupu. Výsledek pod limitem
není testem úplnosti upstreamu ani celostátního pokrytí.

Cache evidence testy ověří `unresolvedStaleEntries` a request-scoped source
fallback warning: úspěch jiného klíče ani nové cache čtení agregace nesmí
zahladit degradaci původních source dat. Cílené deployment testy pokrývají
safety-only Compose patch, zachování ostatních služeb/secrets a validaci
očekávaných kotev; neprokazují live rollback nebo mount.

`notification-load-budget.test.ts` ověřuje pevný 8s limit, sanitizované 503,
studenou i hot cache, coalesced obnovu, pozdější odmítnutí a úklid timeru.
`test.http.test.ts` používá pouze lokální HTTP fixture: stejný provider timeout
musí zahrnout hlavičky i celé JSON/text tělo. `notification-source-freshness.test.ts`
ověřuje původní čas vnořené current cache, zachování stale fallback evidence
při hot/coalesced čtení i po evikci a nepřepisování stáří úspěchem jiného klíče.
Reference metadata/historie nejsou current snapshot; neplatný či budoucí
source čas je fail-closed. Hydro expirace se váže k poslednímu měření +2 h,
nikoli k novému načtení payloadu. Žádný test nevolá živého poskytovatele.
Image-only deployment test zachovává všechny ostatní `.env` bytes a odmítá
chybějící/duplicitní image selection; runtime proof je samostatný krok.

Bounded-snapshot oprava 10.10.2026: všech 193/193 Safety testů (11 souborů)
prošlo na Node 24.21.0 / pnpm 10.33.0, včetně 13 budget, 10 HTTP-body a
10 nested-freshness/hydro regresí. Dále 5 image-only deploy, 4 security kontrakt
a 12 gateway patch testů; service typecheck/build, skeleton, OpenAPI sanity
a generátor consistency prošly. Celá workspace suite není důkazem této
scoped opravy a nebyla znovu spouštěna. Živé ověření je samostatné v kontraktu 21.

Read-time regresní HTTP testy musí na totožném snapshotu prokázat stáří
296 → 301 → 520 sekund, stale-if-error odmítnutí, skutečnou recovery,
expiraci události při dalším čtení a ignorování falešných klientských časů.
Oba GET endpointy mají no-store/Pragma i u 400 a news feed cache se sdílí dál.
Skutečný Nginx test používá syntetický backend: exact GET vždy BYPASS,
aktuální generatedAt/sequence, zachování query, veřejný zdroj 403 a upstream
503 bez stale 200. Běžná flight cache dál musí projít MISS → HIT → STALE.
Lokální test nepotřebuje publikovaný port ani produkční síť. Kontraktní test
navíc ověřuje přesně dva interní security overrides a zachovaný bearer default
i soukromé/service auth operace. Gateway patch test zachová všechny ostatní
bytes včetně driver-measurements deny route, prověří idempotenci a odmítnutí
neočekávaných kotev; není sám o sobě důkazem živého reloadu.

Při následném nasazení zopakovat `verify-crisis-context-runtime.mjs` ze SIM
i COP bez cache-bust query nebo časových hlaviček. Dvě čtení musí mít nový
`generatedAt` a při stejném snapshotu rostoucí, skutečnému času odpovídající
age. Samostatně doložit gateway config hash, nezměněnou identitu webu,
veřejný zdroj 403 a privátní/admin endpointy 401.

Následná freshness oprava 10.10.2026: 160/160 testů celé Safety Data API a
20/20 kontrakt/deploy patch testů prošlo na Node 24.19.0/pnpm 10.33.0;
skutečný lokální Nginx fixture smoke dvakrát prošel bez publikovaného portu.
Živý gateway reload i přímá COP→SIM cesta potvrdily no-store/BYPASS,
rostoucí skutečné stáří a nový generatedAt; veřejný HTTPS ingress 403 a
privátní/admin odmítnutí 401. Service typecheck/build, skeleton a
OpenAPI validation/build consistency prošly. Redocly lint má pět existujících
warningů mimo změněný kontrakt. Celá workspace suite nebyla spouštěna.
Živý provider smoke ze SIM i COP, runtime identita a návrat při nepřijetí
prvního RSS byly samostatně ověřeny; přesná evidence je v kontraktu 21.
COP opt-in/AOI, rozhodování, deduplikace a skutečné background doručení na
zařízení vyžadují samostatnou společnou akceptaci; SIM testy je nepotvrzují.
Viz [kontrakt 21](../integration/21_CRISIS_CONTEXT_AND_REGIONAL_ALERTS_CONTRACT.md).

Následná nezávislá COP serverová akceptace potvrzuje dvě živá čtení bez
cache-bust s age `0 → 2.033 s`, odmítnutí v RAM zestárlé ready odpovědi na
301 sekund a expirovaného kandidáta; nelze ji označit jako pozorování skutečně
301 s staré produkční snapshoty. Bez test push/AI request, nula opt-in i
delivery rows; zařízení/background doručení zůstává neověřené.
Po změně byla vyžádána reindexace přes recall MCP; vrátila
`Error executing tool reindex_repo`. Retrieval před změnou fungoval, žádný
Chroma rebuild se neprováděl. Toto omezuje aktuálnost vývojového indexu,
nikoli výsledky přímých testů nebo runtime nasazení.

## Graph-native traffic promotion

Run `python3 deploy/valhalla/test-native-canary-ab.py` and
`python3 deploy/valhalla/test-native-live-selection.py`, followed by the existing
traffic updater/expiry/physical-archive suites. The selection tests cover
default-off, root-only file ownership, strict approval, graph/static rotation,
changed graph/baseline, whole-edge/reference/cross-candidate conflicts and
fingerprint invalidation. A full synthetic archive activation/rollback test
preserves the baseline bytes and physically zeros the added edge on return.
The bound, private same-flow pilot is separate from fixture tests and does not
replace operator geographic acceptance or independent actual trip-time evidence.

## Consented driver measurements

Run `pnpm --filter @csm-sim/situation-data-api exec vitest run
test/driver-measurements.test.ts`. These synthetic tests cover input/auth/consent,
quality and direction guards, graph rotation/partial edges, exact replay,
limits, revocation and storage/matcher outages. They do not prove live ETA.

For actual PostgreSQL tests, provision a disposable dedicated database, never
a production database, and set `DRIVER_MEASUREMENTS_TEST_DATABASE_URL` for
`test/driver-measurement-store.test.ts`. The suite creates schema and a restricted
test role, truncates its own tables and drops the role afterward. It must not
run against SIM/COP/provider databases. Tests cover repeatable migration,
no-DDL runtime, transactions, deduplication, aggregation thresholds, dataset
separation, expiry and cascading revocation. The suite skips if no explicit
test URL is supplied; report that separately from executed tests.

Joint COP/Jízda consent/outbox and on-device acceptance, capacity/load testing
and independent direction/ETA evaluation remain production gates. See
[integration contract](../integration/20_JIZDA_DRIVER_MEASUREMENTS_CONTRACT.md).
