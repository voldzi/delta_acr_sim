# 21. Jízda–COP–SIM: aditivní bezpečnostní routing

## Běžné mapované profily (ADR 0033)

Závazné schema `openapi/fragments/mapped-road-profile-v1.schemas.json` je
vložené do OpenAPI s prefixem `MappedRoadProfile`. Příklady všech čtyř intentů
jsou v `openapi/examples/mapped-road-profiles.synthetic.json`; jde o syntetické
kontraktní fixtures, nikoli produkční navigaci. `vehicleProfile` je optional
na obou route/alternatives endpoints; COP posílá explicitní `profileId=car`.
SIM při vynechání profileId defaultuje car, nikdy emergency.

Profile: version=`sim-mapped-road-profile-v1`, intent=`car|commercial_truck|
car_with_trailer|road_legal_4x4`, coverageAcknowledged=`mapped_restrictions_incomplete`.
Vehicle vyžaduje všechna `heightM,widthM,lengthM,loadedWeightKg`, pokud je přítomné;
truck a trailer je vyžadují vždy. Hmotnost a délka popisují celou naloženou
soupravu. Přívěs navíc vyžaduje `trailer.attached=true` a jeho čtyři parametry.
Pouze truck má optional `axleLoadKg,axleCount`. Bounds jsou software bounds
schema, ne právní limity: height<=5m,width<=3m,length<=25m,weight<=60000kg,
axle<=40000kg,count2..20; všechny dimenze kladné. Celkové údaje nesmějí být
menší než přívěs a axleLoad nesmí přesáhnout loadedWeight.

Nepřijímat neznámé klíče, unit coercion, konfliktní legacy vehicle nebo strict
trip. Alternatives1..3, via0..12, include flags skutečně boolean. Neznámá avoid
hodnota/objekt znamená400. Známé fire/flood a jakýkoli explicitní departureTime
jsou422 unsupported. Implicitní odjezd nyní se předá vynecháním departureTime.
`driverDeclaredAuthorization=false` je přípustné; true je422 unsupported,
ne příkaz ignorovat access. Všechny čtyři profily mají neúplné mapové pokrytí.

`routes[].mappedProfileAssessment` = version, appliedProfile, profileHash,
requestHash, geometryHash, state=applied, coverage=mapped_restrictions_incomplete,
engine(provider=valhalla,version=3.8.3,costing=auto|truck,fallbackUsed=false),
routingDataset, appliedFields, validUntil, lastMile a limitations. Totožný objekt
je ve feature.properties; strict assessment se nesmí zaměnit za tento objekt.
ProfileHash váže canonical celý profil; requestHash celý normalizovaný query,
geometryHash GeoJSON varianty, algoritmus jako knownClosures. Engine/graf/
deadline musejí odpovídat knownClosures stejné varianty. COP ověří vstupní
identity, všechny varianty, feature copy a endpoint vzdálenost; hashes neřeší
úplnost OSM omezení ani právní garanci. Klient nevytváří vlastní assessment.

LastMile target jsou původní cílové souřadnice; mappedEndpoint skutečný poslední
bod route geometry; distanceM je haversine sR=6371000m. Pouze přesná shoda dává
mapped_target, ostatní<=25m target_guidance_only. Geometrie se neprodlužuje
na cíl. Větší snap:422 ROUTING_TARGET_NOT_ROUTABLE, u jiného bodu
ROUTING_WAYPOINT_NOT_ROUTABLE. Engine failure bez ověřitelné route:502;
nedostupný profil/accepted path:503 ROUTING_PROFILE_UNAVAILABLE. Bez fallbacku.

Catalog `mappedProfiles` má version=`sim-mapped-road-profile-capabilities-v1`,
availability=`disabled|requires_runtime_validation`, čtyři intents/supportedFields/
limitations, maxSnapDistanceM=25, strictGuarantees=false,
driverDeclaredAuthorization=unsupported, unmappedLastMile=unsupported.
Truck použije truck, ostatní auto; trailer-specific bans/turning clearance
nejsou vyhodnocené. 4×4 má road-first preference, není obecná terénní navigace
ani odstranění access omezení. Širší přání soukromého či nemapovaného vjezdu
zůstává mimo akceptaci této etapy.

Měření, tokeny, síť, live traffic/ETA a vypnutý strict režim se nemění.
COP/SDK nesmí při400/422/502/503 zahodit profil a použít default car či MapKit.

## Přísný trip — samostatná vypnutá větev

Stav: implementovaný opt-in kontrakt, výchozí stav vypnutý; nikoli aktivace klienta
nebo potvrzení současných uzavírek. Základ API a `sim-routing-route-v1` zůstává.
JSON schemas: `openapi/fragments/road-trip-v1.schemas.json`; COP je přebírá
beze změny. SIM používá prefix `RoadTrip` v závazném OpenAPI.

## Request a immutable identity

Nové optional pole `trip` na `/routing/route` a `/routing/alternatives`.
Pokud je přítomné, je striktní: neznámé klíče se odmítají (400), všechna pole
uvedená ve schema required musí být předaná. Top-level `from`/`to` zůstávají;
legacy `via`, `vehicle`, `departureTime` se nesmějí kombinovat s `trip`.
`profileId` musí být `car`: nový `intent` není emergency exemption.
`avoid` musí obsahovat `road_closure`; neznámá nebo chybějící hodnota se odmítá.
Známé `fire`/`flood` jsou v strict větvi 422 do samostatné akceptace zdroje;
nelze je tiše vynechat. Varování enginu (včetně clamp) znamená 502 bez fallbacku.

`trip` = version, requestId(UUID), intent(car/commercial_truck/car_with_trailer),
vehicle(heightM/widthM/lengthM/loadedWeightKg/optional axleLoadKg,axleCount/trailer),
departure(now nebo depart_at s UTC at), preferences(avoidTolls,preferPaved),
requirements(roadClosures/legalAccess/vehicleLimits všechny mandatory),
waypoints([] až 12 `{type:via|stop, point:{lat,lon,label?}}`),
destination(`road_point` nebo `approved_entrance` s entranceId).
Vehicle length/weight jsou CELKOVÉ hodnoty naložené soupravy, trailer údaje
popisují její přívěsnou část; nic se implicitně nesčítá. Software bounds nejsou
právní limity. Axle load je nejvyšší naložené zatížení nápravy.

SIM vypočítá SHA-256 nad canonical JSON `{from,to,avoid:sortedUnique,trip}`:
rekurzivně seřazené klíče, pořadí waypointů zachováno, bez zaokrouhlování čísel.
Nepovinný label je součástí identity. Každá varianta vrací vlastní `assessment`
se requestId/requestHash/appliedHash/appliedTrip a hash canonical GeoJSON geometry.
Žádný client-supplied hash, účet nebo profil nesmí změnit serverové požadavky.

## Metadata a chyby

Assessment má vlastní `sim-road-trip-assessment-v1`, skutečný engine/costing,
fallbackUsed, graph version/builtAt/age/freshness, closure revision/observation/
validity/coverage/count, vehicle appliedFields/coverage, waypoint count a lastMile.
V1 bezpečná varianta je jen `engine_route`, Valhalla, fallbackUsed=false.
Neúplná OSM restriction coverage se vždy výslovně uvádí; není to garance průjezdu.
Existující GET `/routing/profiles` má aditivní pole `capabilities` se schema
`RoadTripCapabilities` a verzí `sim-road-trip-capabilities-v1`. Samostatný endpoint
se nezavádí. `disabled` / `requires_runtime_validation` není tvrzení o zdraví
zdroje; každý požadavek zvlášť ověří engine, graf a closure snapshot.

- 400 `ROUTING_TRIP_INVALID`: struktura, rozsah nebo konflikt legacy polí.
- 422 `ROUTING_SAFETY_UNSUPPORTED`: trailer/axle/departure/entrance či engine
  neumí požadavek skutečně použít. NIC se potichu nevynechá.
- 503 `ROUTING_CLOSURES_UNAVAILABLE`, `ROUTING_GRAPH_STALE`,
  `ROUTING_SAFETY_CHANGED`: nedostupná/expirující closure snapshot, starý graf
  nebo změna revize během výpočtu. Žádný unconstrained fallback/stale cache.
- 502 `ROUTING_SAFETY_ENGINE_FAILED`: povinné požadavky nepřežijí engine failure.

Capabilities jsou konzervativní: aktivace truck/trailer/axle vyžaduje konkrétní
engine test a schválený zdroj uzavírek; planned departure vyžaduje správnou
origin timezone a časový coverage snapshot. Approved entrance se serverově
vyhledá podle entranceId, nesmí být pouhá klientská souřadnice či domnělé právo.
Nepodporovaný last-mile nevytváří jízdu napříč terénem nebo privátní komunikací.

## Uzavírky a ověření

Povinné uzavírky vyžadují autoritativní, revidovanou, časově omezenou snapshot
vázanou na aktivní graf. Reprezentativní SRTI pin není directed closure mapping.
Všechna relevantní omezení se aplikují bez výběru podle přímého OD koridoru;
alternativa nesmí uniknout přes uzavírku mimo tento koridor. Expirace/revokace/
změna směru/in-flight graph update invalidují výsledek i cache.
Valhalla hard exclusions jsou experimentální a nedostatečný avoidance se nesmí
zaměnit za garanci; viz [oficiální API](https://valhalla.github.io/valhalla/api/route/api-reference/).
Both-direction physical closure lze pilotovat jako reviewed exclude_polygons
s nezávislým route-geometry/edge auditem; polygon není selektivní jednosměrná
GraphId exclusion. One-direction closure bez ověřeného directed mechanismu
znamená unsupported, nikoli rozšíření nebo tiché ignorování.

Konkrétní uzavírka se nesmí trvale hardcodovat z uživatelského podnětu.
Soukromý revidovaný podklad, aktuální oficiální zdroj a skutečný engine test
jsou podmínky aktivace běžné částečné větve popsané níže.

## Roundabouts

Nové `steps[].roundabout`: phase enter/exit, source valhalla_maneuver,
countState provider_supplied/unknown, exitCount>0 jen pokud jej dodal engine,
exitRoadNames a signNames pouze z provider response. Staré roundaboutExitCount
se zachová. Neodvozovat bearing nebo číslování z pořadí bodů či screenshotu.
Provider count ještě neprokazuje správnost pro konkrétní naložené vozidlo;
reálná křižovatka a přístupová omezení musí projít společnou akceptací.

Měření Jízdy/shadow_only/secrets/intake flags ani live traffic writer nejsou
součástí této změny. COP zajišťuje OIDC adapter a SDK, SIM engine validation.

## Přesné mapování enginu a preference

`car` používá `auto`, `commercial_truck` používá `truck`, nikoli emergency profile.
Valhalla 3.8.3 AutoCost i TruckCost kontrolují height/width/length/weight.
`loadedWeightKg / 1000` je jediný převod jednotek. `appliedFields` jsou přesně
`heightM`, `widthM`, `lengthM`, `loadedWeightKg`. Axle/trailer se NEODVOZUJÍ z
hmotnosti. Všechna ignore access/restriction/oneway/closure nastavení jsou false;
truck `hgv_no_access_penalty=43200`. Pořadí bodů se neoptimalizuje: stop→break,
via→break_through (leg boundary bez U-turn), oba se ověřují z geometrie každé
vrácené varianty. Odvozené pomocné `via` není součástí requestHash.

`avoidTolls=true` je preference `use_tolls=0`, nikoli zákaz všech mýtných silnic.
`preferPaved=true` je konzervativní `exclude_unpaved=true`: engine nepovolí
nezpevněný vnitřek trasy, start/cíl může mít nezpevněný úsek. Neznámý OSM surface
není důkaz zpevnění. Žádný parametr nezakládá právo vjezdu na soukromou cestu.

Zdroj pro přesnou verzi: [AutoCost 3.8.3](https://github.com/valhalla/valhalla/blob/3.8.3/src/sif/autocost.cc),
[TruckCost 3.8.3](https://github.com/valhalla/valhalla/blob/3.8.3/src/sif/truckcost.cc).
Roundabout typy jsou 26 enter / 27 exit; 25 je merge, ne kruhový objezd.
ExitRoadNames bereme jen ze street_names skutečného exit manévru; chybějící
název/count se nedoplňuje odhadem ani ze snímku jiné trasy.

## Běžné knownClosures: částečné pokrytí, nikoli strict assessment

Přechod stejné schválené geometrie na novou mapovou revizi může využít
omezenou mechanickou kontrolu dle ADR 0032. COP stále ověřuje konkrétní
dataset, revision, request/geometry hash a deadline; žádná výjimka pro starý
graf. Neúspěch znamená 503 `ROUTING_KNOWN_CLOSURES_REVIEW_REQUIRED`, nikoli
pokyn pro Apple/OpenAI či unconstrained routing fallback. Veřejné schema se
nemění. Skutečný budoucí graf je přijat až po jeho skutečném probe, ne jen
podle testu workflow na předchozím grafu.

Závazné schema: `openapi/fragments/known-road-closures.schema.json`, komponenta
`SituationDataKnownRoadClosures` v OpenAPI. Optional `routes[].knownClosures`
a totožná hodnota v odpovídající route feature. `state=applied` znamená pouze
aplikaci uvedených individuálně revidovaných uzavírek; `coverage=incomplete`
je povinné. Žádný `assessment` se ve větvi nevyrábí.

Pole: version, state, coverage, revision, observedAt, validUntil,
appliedClosureCount, geometryHash, requestHash, exclusions,
routingDataset(version/builtAt), engine(provider/version/fallbackUsed=false),
limitations. Exclusions mají closureId/sourceDirection/enforcedDirection/
enforcementReason/reviewedGeometryHash. `sourceDirection=unknown` může mít
pouze konzervativní whole-structure reason; nikdy se netvrdí zdrojový both.

`requestHash` = SHA-256 canonical JSON celé `response.query`: rekurzivně
seřazené klíče, beze změny array order a bez zaokrouhlování. SIM normalizuje
profileId (default car), from/to/via souřadnice a trimmed labels, via default
[], avoid default [], alternatives (route default 1, alternatives default 2,
clamp 1–3). Undefined optional hodnoty nejsou v JSON; explicitní include flags
zůstávají. COP musí před hash kontrolou ověřit skutečnou identity požadavku,
nikoli jen důvěřovat přiloženému query. Dropped/unsupported options odmítá.

`geometryHash` váže canonical GeoJSON konkrétní varianty; všechna metadata
route features se musí shodovat. Každá raw native varianta se validuje před
filtrováním. Všechny varianty sdílejí revision/exclusions/engine/dataset;
count = počet unikátních exclusions. observedAt <= now < validUntil <=
observedAt + 10 min a současně graph freshness deadline. Dataset přesně
odpovídá coverage; graf nejvýše 10 dní, nikdy future. Chybějící pole není
accepted. Hash neprokazuje sám původ/legal coverage; odpovědnost SIM publisheru.

Tato cesta používá native engine bez route cache či fallbacku, snap <=25 m,
pouze odjezd nyní. Strict trip nikdy nedowngradovat. Změna zdroje/grafu či
expirace během výpočtu: 503 `ROUTING_KNOWN_CLOSURES_CHANGED`; source/review
chyba: 503 `ROUTING_KNOWN_CLOSURES_UNAVAILABLE` nebo
`ROUTING_KNOWN_CLOSURES_REVIEW_REQUIRED`; engine/geometry: 502
`ROUTING_KNOWN_CLOSURES_ENGINE_FAILED`; budoucí odjezd: 422
`ROUTING_KNOWN_CLOSURES_UNSUPPORTED`. Žádné přímé náhradní volání.

### Neroutovatelné body (ADR 0036)

Pro revidované známé uzávěry a strict `trip`, v `route` i `alternatives`,
se přímé Valhalla `/route` HTTP 400 s číselným `error_code=171` překládá na
422 `ROUTING_LOCATION_NOT_ROUTABLE`. Některý bod nelze korelovat na aktuální
graf pro tento profil/toleranci. Neprokazuje chybu cíle ani nedostupnost enginu.
Valhalla 3.8.3 nevrací index; SIM neparsuje provider text a ignoruje domnělý
`location_index`. Veřejná zpráva je pevná, bez upstream textu či souřadnic.

Při ověřené vrácené geometrii a snapu za tolerancí je kód 422
`ROUTING_TARGET_NOT_ROUTABLE` pro cíl nebo `ROUTING_WAYPOINT_NOT_ROUTABLE`
pro start/mezibod. Platí i pro surplus varianty. Nečitelná geometrie, warnings,
průnik uzávěry, timeout, HTTP 5xx, vadný JSON/kód a 171 z `/status` zůstávají
ochrannými chybami. Trace failure zachovává explicitní unavailable attributes.
Legacy a walking/bicycle se nemění.

COP předá HTTP status a přesný `error.code`; klientovi vrací vlastní
`error.correlationId` z COP požadavku (nepředpokládat shodu s ID SIM). Žádná 422
není transient outage ani povolení Apple fallbacku. Jízda může požádat o
výslovnou opravu bodu/příjezdového místa; poslední míle mimo ověřenou geometrii
není sjízdná trasa. Bez automatického locate, retry, zvětšení 25m limitu,
odebrání profilu/uzávěr nebo vymyšlené final leg. Chyba neobsahuje trasu/proof;
předchozí trasa si zachová jen původní platnost a zřetelný failure/stale stav.

Directed road attributes: ověřené přesné opakování prvního vertexu v
Valhalla edge_walk může sdílet index0. Nejde o obecné slučování blízkých
bodů/loopů; interior repeats stále potřebují vlastní forward index. Není-li
celá trace geometry a edge coverage ověřitelná, attributes/tunnels zůstanou
výslovně unavailable/unknown; known closure a navigation mají vlastní kontroly.
# Arrival candidate, 2026-10-23 — not enabled, pending COP/SDK agreement

The independently reproducible Penny address result contains trip warning 401:
Valhalla's first pass failed and its retry relaxed restrictions. The control
arrival has no warning. This is not evidence of a 25 m failure or lawful access.
The candidate SIM known-closure path rejects an isolated numeric warning 401
with 422 `ROUTING_RESTRICTIONS_RELAXATION_REQUIRED`, after all returned variants
pass geometry and closure checks. Mixed/unknown warnings remain 502; strict
road-trip behavior is unchanged. Neither response supplies navigable geometry.

## Proposed opt-in contract (not the binding production OpenAPI)

Capability `userSelectedArrival`; version `sim-user-selected-arrival-v1`; existing
POST `/situation-data/api/v1/routing/route`. Do not advertise capability until
all three owners agree and SIM, COP/SDK and Jizda support it. No automatic
arrival selection in this version. Caller explicitly selects a public/map
arrival coordinate; this is not an attestation of legal vehicle access.

Proposed additional request field, strict object with no unknown keys:

```json
{"to":{"lon":17.3814008,"lat":50.1214775},
"arrival":{"version":"sim-user-selected-arrival-v1",
"target":{"lon":17.3810814,"lat":50.1215849},"selection":"user_selected"}}
```

`to` is the explicitly user-selected road arrival; `arrival.target` is the original POI.
Start is `{ "lon":17.3831568,"lat":50.1209513 }`. Only plain `profileId=car`,
1–3 alternatives, no `departureTime`, `via`, `trip`, `vehicle`, `vehicleProfile`
or strict intent in the first version; incompatible fields return 422 without
profile downgrade. Coordinate WGS84 finite, no unknown keys. Agreed candidate 250 m
maximum selected-arrival-to-original-target separation is a product guardrail,
NOT a snap tolerance or access proof. The selected arrival still has the
unchanged <=25 m engine endpoint tolerance. Final limits require agreement.

Proposed per-route `arrival` response (all objects strict, all fields required):

```json
{"version":"sim-user-selected-arrival-v1",
"selection":"user_selected","target":{"lon":17.3810814,"lat":50.1215849},
"requestedAccess":{"lon":17.3814008,"lat":50.1214775},
"mappedEndpoint":{"lon":17.381415,"lat":50.121474},
"distanceM":26.86,"remainingAccess":"unverified",
"requestHash":"<hash-entire-response-query>","geometryHash":"<sha256>",
"routeId":"<variant-id>","profileId":"car","closureRevision":"<revision>",
"routingDataset":{"version":"<actual-graph>","builtAt":"<date-time>"},
"validUntil":"<date-time>"}
```

Numbers above illustrate the prior control result, not a signed or current
proof. SIM issues hashes and proof, never accepts them as client attestations.
Distance is endpoint-to-original-target, not a walkable distance. Route distance,
duration and maneuvers end at the road endpoint; no final connector or pedestrian
ETA. Existing v1 mapped assessment/lastMile never changes its 25 m meaning.

Every alternative must independently pass the existing directed engine route,
warnings, geometry, closure and validity checks, then bind its original target,
selected arrival, effective request and all proof fields. Mapped graph access
is incomplete; no proof of physical barriers, parking rights or lawful entrance
is asserted. Where sufficient map access evidence is unavailable, retain
unverified status or reject; never invent an automatic legal arrival.

The first arrival candidate bypasses completed-result and native single-flight
caches (`cachePolicy=no_cache`). All hashes include the entire preserved query,
including original target, arrival version/selection and selected `to`, profile,
graph, closures and traffic generation. Feature properties carry exactly the
same per-variant arrival object as the route.
Use the minimum existing graph/closure/traffic validity. Changed/expired proof
fails closed. Responses to requests without opt-in are unchanged. Older clients
must not opt in and must reject unknown arrival versions. COP/SDK preserve the
per-variant proof; Jizda must not declare POI arrival or terminate recording
merely because road navigation ends.

Acceptance: 401 root/trip/alternate, mixed warning, invalid geometry and closure
precedence, Penny/control, 24/25/26/27 m around selected-arrival snap, original
target separation and 250 m boundary, alternative and stop rejection, strict/
vehicle/profile rejection, barriers/opposite carriageway/access uncertainty,
expired graph/closure/traffic proof, old clients, authenticated COP-to-SIM-to-SDK
and physical iPhone. Candidate source is not production proof.

Candidate capability shape:
`userSelectedArrival={version:'sim-user-selected-arrival-v1',availability:'requires_runtime_validation',selection:'user_selected_only',profileIds:['car'],maxRemainingDistanceM:250,maxSnapDistanceM:25,remainingAccess:'unverified',cachePolicy:'no_cache'}`.

Agreement status: SIM accepts the exact COP candidate delivered on 2026-10-23,
superseding the earlier SIM 500 m/original-to proposal. Pending final COP/SDK
and Jizda acknowledgement and joint acceptance. This document is not production
activation or proof of a legal entrance. Arrival is now implemented only in the
isolated SIM candidate; joint COP/SDK/iPhone acceptance remains pending.

The sole shared schema is copied unchanged from COP as
`openapi/fragments/user-selected-arrival-v1.schemas.json`, SHA-256
`210b06c0cd3f093d91529721b21b7ffed26e28be5d625a15a6d62a67c7f36e8c`.
It supersedes the illustrative response above: the exact response additionally
requires `snapDistanceM` and `engine={provider:'valhalla',version,costing:'auto',fallbackUsed:false}`.
`includeSteps=true` is mandatory. Both request access-to-POI and actual
endpoint-to-POI distances must be <=250 m. The shared Haversine radius is
6371000 m; no distances are rounded. COP independently verifies to 0.01 m and
SDK to 0.5 m. `arrival` is preserved in the entire normalized query before
request/closure hashes are generated; metadata is identical in each route and
its matching feature. Known closure engine and vehicleAssessment auto costing
must match. Missing opt-in produces no metadata.

Errors: malformed arrival 400 VALIDATION_ERROR; disabled/incompatible arrival
422 ROUTING_ARRIVAL_UNSUPPORTED; either remaining distance >250 m 422
ROUTING_ARRIVAL_TOO_DISTANT; invalid proof 502 ROUTING_ARRIVAL_INVALID. No route
data accompanies an error. No endpoint-specific ARRIVAL_UNSUPPORTED alias.

Candidate evidence 2026-10-23: exact COP two-variant fixture imported unchanged,
SHA-256 `a4b1334ad003eb479a1bf76a9ccf8c703117a37a8bbb6688102b63427a18dc98`.
SIM reproduces both arrival proofs byte-for-value, including canonical query and
geometry hashes, distances, capability and feature metadata. 751 service tests
pass, 6 skipped; typecheck/build/OpenAPI and skeleton checks pass. Coverage
includes 24/25/26/27 m snap and POI separation, oversized remaining distance,
missing consent/steps, disabled runtime, incompatible profile/vehicle/stop fields,
malformed schema, expired/hash/costing proofs, all variant binding, no native
coalescing and warning401/unknown-warning/geometry/closure precedence.
These synthetic results do not prove a lawful real entrance or deployed
COP-to-SIM-to-SDK/iPhone behavior. Those acceptance gates remain open.

