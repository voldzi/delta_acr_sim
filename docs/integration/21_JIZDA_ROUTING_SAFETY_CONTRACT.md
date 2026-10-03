# 21. Jízda–COP–SIM: aditivní bezpečnostní routing

Stav: návrh wire polí pro společnou implementaci, nikoli aktivace klienta nebo
potvrzení současných uzavírek. Základ API a `sim-routing-route-v1` zůstává.
JSON schemas: `openapi/fragments/road-trip-v1.schemas.json`; COP je přebírá
beze změny. SIM používá prefix `RoadTrip` v závazném OpenAPI.

## Request a immutable identity

Nové optional pole `trip` na `/routing/route` a `/routing/alternatives`.
Pokud je přítomné, je striktní: neznámé klíče se odmítají (400), všechna pole
uvedená ve schema required musí být předaná. Top-level `from`/`to` zůstávají;
legacy `via`, `vehicle`, `departureTime` se nesmějí kombinovat s `trip`.
`profileId` musí být `car`: nový `intent` není emergency exemption.
`avoid` musí obsahovat `road_closure`; neznámá nebo chybějící hodnota se odmítá.

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
Nový `/routing/capabilities` ukáže aktuálně dostupnou podporu jednotlivých intentů,
polí a uzavírek; schema přijetí není důkaz podpory konkrétního runtime.

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

III/44520, OSM 48835964, pin 50.1257919/17.3629376 je pouze podnět k ověření.
V tomto změnovém balíku se nenastavuje žádná skutečná ani permanentní uzavírka.

## Roundabouts

Nové `steps[].roundabout`: phase enter/exit, source valhalla_maneuver,
countState provider_supplied/unknown, exitCount>0 jen pokud jej dodal engine,
exitRoadNames a signNames pouze z provider response. Staré roundaboutExitCount
se zachová. Neodvozovat bearing nebo číslování z pořadí bodů či screenshotu.
Provider count ještě neprokazuje správnost pro konkrétní naložené vozidlo;
reálná křižovatka a přístupová omezení musí projít společnou akceptací.

Měření Jízdy/shadow_only/secrets/intake flags ani live traffic writer nejsou
součástí této změny. COP zajišťuje OIDC adapter a SDK, SIM engine validation.
