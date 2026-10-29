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

Obě budou vyžadovat explicitně oprávněnou službu COP a validní request-scoped
`X-Correlation-ID` UUID. Hlavička je korelace, nikoli autorita. Tělo neobsahuje
klientem volitelné userId, službu, signing klíč nebo účet. Důvěryhodnou identitu
účtu dodá pouze nově vymezená službová delegace, před jakýmkoli engine voláním.
**Skutečný výchozí stav:** běžný SIM routing nemá tento actor resolver; COP
routing adapter podle source neposílá ani předpokládaný service bearer.
SIM `geo-routing.ts:98–105` má oddělený constant-time Bearer lookup do
`config.geoRoutingPrincipals`, naplněný `GEO_ROUTING_SERVICE_TOKENS`.
Není to uživatelský resolver a jeho existence neznamená aktivní propojení COP.

Návrh konkrétní extension: planning endpoint použije tento service-principal
lookup a nový explicitní `planningOriginAllowedServiceActors` allowlist,
výchozí prázdný/deny. Všem geo principals nelze automaticky rozšířit scope.
Konkrétní navržené config mapování: existující `GEO_ROUTING_SERVICE_TOKENS`
zůstává seznam `actor:opaque-token` oddělený čárkami (`config.ts:309–319`), nový
`PLANNING_ORIGIN_ALLOWED_SERVICE_ACTORS` je pouze seznam povolených názvů actorů,
žádné tajemství. Nové operace budou mít pevný audience label
`csm-sim-planning-origin-v1` a scope label `planning-origin:read`; tyto labely
nejsou kryptografické JWT audience ověření. Existující `GEO_ROUTING_AUDIENCE`
(default `csm-sim-geo-routing-v1`, config.ts290) se nezmění pro starý endpoint.
Opaque bearer nemá podepsané claims; účel nových operací vynutí jejich router
spolu s explicitním actor allowlistem, nikoli samotný text audience.
Prostý token match bez tohoto nového scope checku není dostatečná implementace.
Ve zkoumaném situation source nebyl nalezen obecný JWKS/user-JWT verifier pro
routing; návrh jej nepředpokládá ani nově nezavádí. Stávající COP adaptér nemá
geo credential konfiguraci, takže případné provisionování není hotový fakt.
COP vytvoří `X-COP-Planning-Actor` jako lowerhex SHA256 UTF8 řetězce
`cop-planning-actor-v1` + NUL + ověřený OIDC issuer + NUL + ověřený subject.
Každý dotaz jej nově odvodí z aktuálně ověřené session a **přepíše**, nikdy
nekopíruje klientské body/hlavičky. Neznámá/neověřená session se odmítne.
SIM jej přijme jen po ověření allowlisted COP service bearer. Jde o důvěru
službové delegaci pro quota/request vazby, nikoli uživatelský access token,
nezávislé ověření OIDC nebo nové oprávnění přístupu k datům. Hlavička sama
bez služby žádnou autoritu nemá; hodnotu ani surový subject/issuer nelogovat.

**Freeze/deployment gate:** potvrdit jméno existujícího legitimate service
principalu a schválený planning scope i serverovou konfiguraci COP. Reuse
existujícího tokenu se schválí pro tento scope, nikoli předpokládá. Návrh
neprovádí přenos/zobrazení tokenu, nevytváří nový klíč, nepoužívá AI/erasure HMAC.
MVP je stateless bez cache kandidátů, přístup k historickým uživatelským datům
se nezavádí. Body userId nebo externí header bez autentizované delegace odmítnout.
Root následnou úzce omezenou inventurou potvrdil existující SIM service actor
`cop`; žádná hodnota tokenu nebyla předána. COP zatím odpovídající konfiguraci
nemá. Konkrétní budoucí COP secret key je `COP_ROUTING_PLANNING_SERVICE_TOKEN`;
SIM nový allowlist bude výslovně jen `cop`. Provisionování kopie existujícího
legitimate geo tokenu do tohoto COP klíče je až samostatný produkční krok po
implementaci/testech, nikoli součást návrhu nebo zde provedená změna.

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

Přesný návrh hash preimage (canonicalRoutingHash, bez string concatenation):
`contextHash=H({domain:"sim-planning-origin-v1/context",context})`,
`profileHash=H(context.vehicleProfile)`, `destinationHash=H(context.destination)`,
`selectionHash=H(selection)`, `geometryHash=H(previewPath.geometry)`.
`requestHash=H({domain:"sim-planning-origin-v1/request",serviceActor,
opaquePlanningActor,context,selection,routingDataset})`, přičemž kandidátní
operace má `selection:null`. Preview `discoveryBinding` musí souhlasit se
znovu vypočtenou kandidátní vazbou; assessment má novou requestHash s výběrem.
Stejné duplicitní hash/dataset hodnoty v binding/assessment musí být totožné.
COP zná serverový actor a kontroluje requestHash; **SDK jej nereprodukuje**.
SDK ověřuje veřejné context/profile/destination/selection/geometry hash,
purpose/contextId a post-await account/profile epoch pod důvěryhodným COP HTTPS.
Jde o obsahovou kontrolu a delegaci služby, ne nový kryptografický podpis.

## Kandidáti: bounded assistance, nikoli průjezdnost

Nejvýše **1 locate** za požadavek, jeden bod, serverový radius/search_cutoff
nejvýše 500 m nezávisle na GPS accuracy, žádný automatický retry. Použít stejný
mapped costing/options, ale pravdivě nezaručit, že lehký locate filtr vyhodnotil
rozměry/časové restrikce. Nejvýše 3 deduplikované plánovací souřadnice, seřazené
deterministicky podle vzdálenosti a stabilního graph klíče vázaného na dataset.
Tentýž prokazatelný fyzický bod protisměrných hran může být jedna nabídka,
ale směry se nezahazují: `directions` uchová opaque directionId a případný
heading zvlášť, každý `validation:graph_candidate_only`. Proti sobě oddělené
jízdní pásy ani různé komunikace se neslučují jen podle blízkosti. Nejde o
výběr nebo vynucení směru výsledné trasy. Nejvýše osm směrů s explicitním
`directionsTruncated`; při nejasné fyzické identitě body neslučovat. Bez
relevantního směru měření se nevymýšlí heading k cíli.

Přijmout pouze validní projekce z `edges`, nikdy `filtered_edges` nebo raw verbose
body, incidenty či traffic. Vzdálenost spočítat nezávisle, čísla/souřadnice
zkontrolovat, response limit/timeout a celkové concurrency/rate budgety sdílet
s dosavadním engine limiterem. Tři výsledky neznamenají tři routing requesty.
`candidateId` je pouze UX korelace, ne tajemství/token/oprávnění.

Každý kandidát: `profileValidation:not_checked`, `legalAccess:not_verified`,
`directionValidation:graph_candidate_only`. Nejde o potvrzený veřejný vjezd.
`choices_available` vyžaduje 1–3 položky, `no_candidates` přesně 0 (runtime invariant).
Totéž nyní vynucuje i JSON Schema podmínka state/count. Candidate ID se navrhuje
jako `candidate:` + H({domain:"sim-planning-origin-v1/candidate",contextHash,
routingDataset,coordinate,directions,directionsTruncated}); žádný raw graph ID
nesmí opustit provider parser. Směrová ID jsou doménově oddělené hashe graphu
a directed edge, ne důkaz směrové navigace.
`validUntil` nejvýše 120 s a nikdy za graph/snapshot validity; po změně grafu
nová nabídka. Žádné další dotazy za účelem automatického zkoušení kandidátů.

## Preview a nepřenositelnost navigační autority

Uživatel výslovně zvolí souřadnici; `confirmed:true` je deklarace klientské volby,
nikoli důkaz skutečného kliknutí člověka. Volba bodu je stejně nedůvěryhodný
vstup jako dosavadní ruční from. Chybí-li volba nebo nesedí dataset, odmítnout.
`Selection` je oneOf: `candidate_selection` vyžaduje candidateId a zobrazené
directions/truncation; `user_map_selection` je výslovně zakazuje. Oba nesou
coordinate a confirmed:true. **Také manuální volba nejprve absolvuje explicitní
candidates request** a převezme `binding.routingDataset`, třeba při no_candidates.
Nový manual originContext znamená novou výslovnou search akci v celkovém budgetu,
ne skrytý retry. `expectedDataset` není klientem vymyšlená verze grafu a SIM ji
vždy ověří proti aktuálnímu statusu.
Odeslané candidateId nikdy neopravňuje přeskočit výpočet nebo jiné kontroly.
Při stateless/cache0 návrhu a nepodepsaných canonical hashích lze ověřit
deterministickou obsahovou shodu candidateId, **nikoli kryptograficky dokázat
historické členství ve skutečně dříve vrácené nabídce**. COP ověří odpověď
v okamžiku přijetí, SDK její vazbu na svůj snapshot; pozdější klientský echo
není serverová atestace. Zdroj candidate_selection je UX informace, ne zvýšení
oprávnění. Chce-li společná revize historickou membership jako bezpečnostní
podmínku, musí výslovně změnit stateless/cache0 nebo zvolit již přijatý signed
proof; samotným hashem ani novým neodsouhlaseným klíčem se mezera nepřekryje.
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
Nový PreviewAssessment nese kromě purpose/binding stejné konkrétní facts jako
dosavadní mapped verifier: state, coverage, appliedProfile, profileHash,
requestHash, engine, routingDataset, appliedFields, lastMile a limitations.
Jejich schema se odkazuje na stejné jednotlivé field definice, ale nemá ordinary
assessment version ani vložený promotovatelný ordinary assessment. COP/SDK musí
znovu použít úplnou sémantickou kontrolu těchto facts pod novým účelem; samotné
`guards` booleans ji nenahrazují. Schema pouze zajišťuje tvar, ne správnost faktů.

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
uvedenou novou minimální actor delegaci/scope, serverovou kontrolu
purpose/assessment a chybové kódy.
Před nativním během: společně schválit přesné syntetické fixture, počet dotazů,
image/dataset, izolaci a resourcelimit; zatím **žádný nový locate/route neběžel**.
Před nasazením: reálná schema/HTTP/auth/age/concurrency/guard test evidence a
rollback nezávislý na běžném route endpointu. Před dokončením: asistovaná volba
a společná fyzická iPhone akceptace původního plánovacího cíle.
