# Společná zdrojová korekce COP–SIM — 14. 10. 2026

## Přesný rozsah

Ověřená čistá SIM revize `7bd5a6381006810c7a4bf3ffa51d13e3b63a61ed`
na `codex/sim-account-erasure-release` a čistá COP revize
`a0c6fd683ab51fa677c485e22c9f9e83621a188b` na
`codex/cop-account-safety-completion-20261013`. Strojově čitelné důkazy,
source hashe a rozsahy jsou v [JSON protokolu](2026-10-14_COP_SIM_ERASURE_HTTP_CORRECTION.json).
Následný commit tohoto důkazu je pouze dokumentační, ne nový testovaný
aplikační obraz. Původní [ověření 68e96e7](2026-10-14_COP_JIZDA_ERASURE_VERIFICATION.md)
se nepřepisuje ani neoznačuje za společnou akceptaci.

Zdrojový cross-review odhalil nesoulady, které oddělené mock testy
neodhalily: přesné `Cache-Control`, odmítání historických dnů nad
povinným intervalem a pokračování přijaté operace při vypnutém příznaku
na straně COP. Opravy zachovaly auth, actor/operation vazbu, původní
`acceptedAt`, úplný immutable digest, finanční limity a trvalé fence.
Vazby požadavku/receipt Driver na UUID 1–5 jsou nyní také v OpenAPI.

## Provedené kontroly

| Kontrola | Výsledek a hranice |
| --- | --- |
| Celá regrese SIM | 591 PASS, 0 FAIL; 6 legacy opt-in PostgreSQL testů SKIP |
| Nativní PostgreSQL 18.3 | 41 PASS: 4 baseline, 7 SQL/RLS, 13 Driver, 17 Router |
| Společný loopback COP→SIM | 10 PASS, 71 skutečných HTTP požadavků |
| Závazné JSON Schema | 70 PASS; 8 binding paths |
| Workspace typecheck/build | PASS na Node 24.16.0, včetně podprocesů |
| OpenAPI | 151 paths / 273 reachable schemas; validace PASS; 18 původních varování mimo erasure |
| Skeleton a diff check | PASS |
| Chroma reindex worktree | Odmítnutá náhradní identita repository; hlavní checkout/index beze změny |

Počet HTTP požadavků není další počet testů. Workspace placeholder
zprávy nejsou browser testy; nový PG běh se nesčítá s šesti legacy skips.
Žádný test nepoužil skutečný účet, OpenAI, produkční DB nebo tajemství.

## Skutečná HTTP hranice, syntetická autorita

`scripts/test-cop-sim-erasure-http.mts` importuje skutečné COP adaptéry a
skutečné SIM Express handlery. Před importem COP ověřuje čistou přesnou
revizi a hashe; před a po běhu kontroluje zdroje. Běží jen na dočasných
loopback portech. Externí fetch, provider a Valhalla matcher jsou zakázané.
Stores, owner/identity proof a publikační barrier jsou **syntetické**.
Tato zkouška není PostgreSQL ani skutečná Root/restore/produkční akceptace.

Ověřené scénáře: 401/no-store/correlation; chybějící autorita nezpůsobí
ready; skutečný Router a Driver capability/preflight/start/status;
historický retained/outbox inventář se všemi 22 páry (11 dnů × 2 verze)
bez zkrácení; 202 zůstává čekající; špatný token a 503 bez fallbacku;
při vypnutí pokračuje vlastní přijatá operace, nevznikne nová ani cizí.
Driver používá výslovný syntetický čas; AI časový guard zůstal skutečný.
Statusy: 200×42, 202×8, 401×4, 404×13, 503×4. Volání provideru/matcheru
a externí síť: 0.

Oddělený nativní PG runner potvrdil, že úplné starší dny a verze jsou
smazané a trvale fenced, pozdní commit se odmítne a jiný actor není viditelný.
Pozitivní owner proof v PG je pouze syntetický testovací callback.
Migrační SHA zůstaly stejné jako v původním ověření; runtime oprávnění
se nerozšířila. Soukromý cluster bez TCP byl po úspěchu uklizen.

## Produkce a další gate

Pasivní kontrola 14. 10. 2026 potvrdila stejné zdravé SDA, Router a COP
obrazy jako v původním protokolu. Nebyla provedena migrace, deployment,
restart, předání secrets ani zapnutí mazání. Shared SIM identita/přístup
se nemění a measurements zůstávají `shadow_only`.

Správce infrastruktury dokončil zdrojový návrh a oddělené izolované
testy, nikoli skutečnou ochrannou službu. Schválení přípravy a ověření
nenahrazuje zřízení aktuálního produceru, nezávislé kotvy, native owner
resolution a admission/commit/fence/drain hranice. Návrhový JWS, TTL, prázdná guard DB
nebo místní boolean nesmí změnit verifier na `true`.

Aktuální Router obraz bez skutečného owner verifieru by zablokoval běžný
COP chat; z tohoto důvodu nebyl nasazen ani s erasure flagem `false`.
Nejprve připravit konkrétní omezený infrastrukturní krok a skutečný consumer
adapter, potom společnou akceptaci nasazeného rozsahu. PBS/WAL/provider
kopie tímto nejsou fyzicky vymazané ani ověřené; skutečný restore exercise
je samostatně odložený. Postup a guard-capable návrat jsou v runbooku 19.
