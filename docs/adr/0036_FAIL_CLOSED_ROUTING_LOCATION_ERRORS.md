# ADR 0036: Přesné chyby korelace silničních bodů

Datum: 2026-10-11. Stav: přijato pro opravu; deployment/živé výsledky odděleně.

## Rozhodnutí

Známá/strict větev dříve měnila i engine171 na obecnou502. Přímé `/route`
HTTP400 s numerickým171 se nově překládá na 422 `ROUTING_LOCATION_NOT_ROUTABLE`.
Ověřená vrácená geometrie za limitem má TARGET/WAYPOINT422 podle skutečného
pořadí bodů, včetně surplus variant. Bez dalšího upstream volání.

[Valhalla 3.8.3 route_action.cc](https://github.com/valhalla/valhalla/blob/3.8.3/src/loki/route_action.cc#L99-L175)
vrací171 bez indexu i při obecné výjimce během korelace. SIM proto nedovozuje
cíl ani obecnou neprůjezdnost místa, neparsuje text a nesděluje provider data.
Pomocné cost-factor body nejsou uživatelské endpoints; legacy/geo/pomocné
požadavky zachovávají stávající chování.

## Zachované hranice

25m tolerance, přesné profily, uzávěry, revize/graph freshness a race/expiry
kontroly zůstávají. Žádný automatický locate, posun cíle, retry, cache fallback,
Apple downgrade nebo vymyšlená poslední míle. Nečitelná geometrie, warnings,
HTTP5xx, malformed/nenumerické chyby, transport a crossing nejsou input error.
Veřejná zpráva je pevná + běžné correlation ID; žádné GPS/raw exception logy.

## Provoz a návrat

Pouze SDA hotfix z přijatého image source, beze změny secrets/pilotních flags
a shadow-only měření. COP/Jízda přijímají422 jako neúspěšnou korelaci a mohou
žádat výslovnou opravu bodu, ne obejít safety. Rollback vrací původní SDA image
bez změny dalších služeb nebo mazání dat. Testy ověřují pozitivní/negativní
engine chyby, body/varianty, HTTP korelaci a nevyzrazení textu. Živá syntetická
serverová akceptace není fyzická iPhone akceptace ani důkaz přesnosti ETA.
