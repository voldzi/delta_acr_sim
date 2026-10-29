# 26. Assisted planning origin — společný návrh kontraktu

Status: **joint-review proposal v0.1**, nikoli nasazené endpointy nebo závazná
produkční specifikace. Návrh pro společné zmrazení je v
[OpenAPI JSON](26_PLANNING_ORIGIN_OPENAPI_PROPOSAL.json). Stávající závazné
`openapi/openapi.json` a běžné route/alternatives se touto změnou nemění.
Po společném freeze musí implementace stejný schválený kontrakt vložit do
závazného OpenAPI; nelze publikovat tyto cesty jen na základě návrhu.

## Přesné navržené operace

- `POST /api/v1/routing/planning-origin/candidates`
  (`planningOriginCandidates`): `CandidatesRequest` → `CandidatesResponse`.
- `POST /api/v1/routing/planning-origin/preview`
  (`planningOriginPreview`): `PreviewRequest` → `PreviewResponse`.

Obě vyžadují stávající autentizovanou službu COP a validní request-scoped
`X-Correlation-ID` UUID. Hlavička je korelace, nikoli autorita. Tělo neobsahuje
klientem volitelné userId, službu, signing klíč nebo účet. Důvěryhodnou identitu
účtu dodá pouze serverový resolver COP/SIM, před jakýmkoli engine voláním.
**Freeze gate:** COP/SIM musí konkrétně doložit tento již přijatý mechanismus
přenosu identity a scope pro nové operace. Pokud neexistuje, nelze si identitu
vymyslet z body/headeru; implementace zůstává zavřená. Návrh neuděluje oprávnění
vytvářet nové klíče nebo znovupoužívat klíče pro mazání účtů.

## Kontext a jeho vazby

`Context` má pevné version/purpose, snapshot `contextId`, explicitní telefonní
nebo ruční původ, nezměněný cíl a celý mapped profil. Telefonní observedAt musí
být runtime stáří 0–900 s, accuracy konečná >0 až 5000 m; nejde o snap radius.
Ruční původ nemá GPS metadata. Všechny neznámé klíče se odmítnou. Přesnost/čas
jsou tvrzení klienta, ne nezávislá serverová atestace polohy.

Server před await pořídí immutable snapshot. Verifikovaný actor scope, context,
profile, destination, vybraný bod, dataset a účel musí být zahrnuty do příslušných
request/cache/single-flight/assessment vazeb; různí uživatelé nejsou sdílená cache.
Hashy používají existující canonicalRoutingHash, s odlišnou doménou
`sim-planning-origin-v1`; requestHash musí zahrnout ověřený actor scope a unikátní
contextId, nesmí do odpovědi přenést skutečné ID účtu. Jde o vazbu obsahu, nikoli
podpis či ochranu proti nedůvěryhodnému serveru. Po await znovu ověřit stáří,
dataset, uzávěry a v COP/Jízda i nezměněný účet/request/profile/destination/context.

## Kandidáti: bounded assistance, nikoli průjezdnost

Nejvýše **1 locate** za požadavek, jeden bod, serverový radius/search_cutoff
nejvýše 500 m nezávisle na GPS accuracy, žádný automatický retry. Použít stejný
mapped costing/options, ale pravdivě nezaručit, že lehký locate filtr vyhodnotil
rozměry/časové restrikce. Nejvýše 3 deduplikované plánovací souřadnice, seřazené
deterministicky podle vzdálenosti a stabilního graph klíče vázaného na dataset.
Stejný promítnutý bod obou směrů nemá zaplnit dvě pozice; směr je jen grafová
informace. Bez relevantního směru měření se nevymýšlí heading k cíli.

Přijmout pouze validní projekce z `edges`, nikdy `filtered_edges` nebo raw verbose
body, incidenty či traffic. Vzdálenost spočítat nezávisle, čísla/souřadnice
zkontrolovat, response limit/timeout a celkové concurrency/rate budgety sdílet
s dosavadním engine limiterem. Tři výsledky neznamenají tři routing requesty.
`candidateId` je pouze UX korelace, ne tajemství/token/oprávnění.

Každý kandidát: `profileValidation:not_checked`, `legalAccess:not_verified`,
`directionValidation:graph_candidate_only`. Nejde o potvrzený veřejný vjezd.
`choices_available` vyžaduje 1–3 položky, `no_candidates` přesně 0 (runtime invariant).
`validUntil` nejvýše 120 s a nikdy za graph/snapshot validity; po změně grafu
nová nabídka. Žádné další dotazy za účelem automatického zkoušení kandidátů.

## Preview a nepřenositelnost navigační autority

Uživatel výslovně zvolí souřadnici; `confirmed:true` je deklarace klientské volby,
nikoli důkaz skutečného kliknutí člověka. Volba bodu je stejně nedůvěryhodný
vstup jako dosavadní ruční from. Chybí-li volba nebo nesedí dataset, odmítnout.
Odeslané candidateId nikdy neopravňuje přeskočit výpočet nebo jiné kontroly.
Nejvýše **1 běžný full-guarded route computation**, žádné alternativní pokusy
po chybě. Nativní transport s neměnným profilem, variant count 1, snap<=25 m,
stejné známé uzávěry/dataset/geometrie/všechna warning401 pravidla.
Pokud route vrátí chybu, nic se neuvolňuje. Další bod smí vyvolat pouze nový
výslovný uživatelský požadavek v původních celkových rate limitech.

Výstup je samostatný `PreviewPath`, **nikoli SituationDataRoutingRoute**:
má preview ID, geometrii, vzdálenost/čas a žádný vložený ordinary route assessment.
`PreviewAssessment` v nové obálce váže purpose, actor/request/context/profile/
destination/dataset/selection/geometry/validUntil a výsledky všech plných guardů.
To vyžaduje novou cestu ve verifieru COP/SDK; prostá booleans nejsou ochrana.
Celá obálka má navigationEligible=false a measurementEligible=false; connector
z measured anchoru k bodu je unknown/nonnavigable a nesmí se stát částí trasy.
Samostatné nahrávání GPS bez navigace tím není blokované.

## Chyby a provoz

400 strict schema; 401 chybějící/nesprávná service auth; 409 změna vazeb/grafu;
422 starý kontext nebo stávající protective routing error; 429 rate budget;
503 engine/capacity/guard unavailable. Přesná enum code je v JSON.
Chyba nesmí exportovat provider text, polohy, tělo, token či účet. Žádný přímý
fallback do enginu/providera a žádné automatické obnovení GPS/placené API.
Žádná archivace měření, soukromých plánů ani verbose provider výstupů.

## Důkazy a následující testy

`node scripts/test-planning-origin-proposal.mjs`: schema-shape testy, nikoli
auth/freshness/limiter/provider nebo route acceptance. Veškerá čísla v testu
jsou vlastní syntetická geometrie, ne soukromá poloha nebo skutečný vjezd.
ADR0050 uvádí primární source evidence locate a úplnou negativní matici.

Před implementačním freeze: prověřit discriminator/wire names s COP/SDK, výše
uvedený actor resolver, serverovou kontrolu purpose/assessment a chybové kódy.
Před nativním během: společně schválit přesné syntetické fixture, počet dotazů,
image/dataset, izolaci a resourcelimit; zatím **žádný nový locate/route neběžel**.
Před nasazením: reálná schema/HTTP/auth/age/concurrency/guard test evidence a
rollback nezávislý na běžném route endpointu. Před dokončením: asistovaná volba
a společná fyzická iPhone akceptace původního plánovacího cíle.
