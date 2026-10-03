# 21. Jízda–COP–SIM: aditivní bezpečnostní routing

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

Directed road attributes: ověřené přesné opakování prvního vertexu v
Valhalla edge_walk může sdílet index0. Nejde o obecné slučování blízkých
bodů/loopů; interior repeats stále potřebují vlastní forward index. Není-li
celá trace geometry a edge coverage ověřitelná, attributes/tunnels zůstanou
výslovně unavailable/unknown; known closure a navigation mají vlastní kontroly.
