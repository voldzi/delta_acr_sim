# ADR 0033: Typované profily pro mapované silniční trasy

Datum: 2026-10-04. Stav: přijato pro aditivní implementaci; nasazení a společná
akceptace COP/Jízda se vykazují odděleně.

## Rozhodnutí

Běžná větev ADR 0032 přijímá optional `vehicleProfile`, nikoli strict `trip`.
Kontrakt `sim-mapped-road-profile-v1` rozlišuje `car`, `commercial_truck`,
`car_with_trailer`, `road_legal_4x4`. Klient výslovně potvrzuje neúplné mapové
pokrytí. Strict bezpečnostní garance se tím nezapínají. Legacy `vehicle` se
s typovaným profilem nekombinuje; není dovolen tichý převod auta na truck.

Přijatý engine je přesná Valhalla 3.8.3. Auto i souprava využívají `auto`;
truck využívá `truck`. Skutečné rozměry a celková naložená hmotnost se předají
enginu, truck navíc podporuje zadané axle load/count. Údaje o přívěsu popisují
část soupravy, nesčítají se automaticky. Trailer-specific bans, articulation,
turning clearance nejsou přijatým mechanismem.

4×4 má road-first preference s přístupem na mapované nezpevněné cesty.
Nepoužívá ignore_access/restrictions/oneways/closures. Globální zrušení access
není selektivní povolení soukromého vjezdu. `driverDeclaredAuthorization=true`
se proto odmítá 422; deklarace řidiče sama nezakládá serverové oprávnění.
Řidič posuzuje aktuální značení, skutečnou průjezdnost a právní přístup.
To neznamená, že server umí vypočítat trasu přes každý legálně povolený vjezd.

Geometrie končí na skutečném mapovaném endpointu. Odchylka od cíle nejvýše25m
se vykáže jako `target_guidance_only`, pokud souřadnice nejsou přesně shodné;
nepřipojuje se imaginární silnice. Větší odchylka selže. Širší nemapovaná
poslední míle a selektivní access authorization vyžadují samostatný návrh a
ověření, tato etapa je neprohlašuje za dokončené.

## Vazba a selhání

Každá varianta a odpovídající feature nesou `mappedProfileAssessment`, vázaný
na celý normalized query, přesný profil, geometrii, engine, graf a platnost
knownClosures. Stejné source/graph/geometry fences ADR 0032 zůstávají povinné.
Bez accepted path není profil dostupný; žádný cache, car downgrade, MapKit ani
unconstrained engine fallback. Capabilities vyjadřují možnost runtime validace,
nikoli právní garanci nebo okamžité zdraví zdroje.

## Důkazy a následky

`scripts/test-mapped-profile-engine.sh` sestaví vlastní syntetický PBF bez
externích dat a bez sítě. Native route+edge_walk v obou směrech ověřuje malé/
velké height/width/length/weight, axle load/count, kombinaci s přívěsem, access
a nezpevněný příjezd. Kontroluje přesnou verzi, warnings, skutečné OSM way IDs
a indexed maneuvers. Test engine není důkaz kvality všech reálných OSM značek.
Unit/integration tests vážou všechny varianty, hashes, deadlines a DTO.

Nevzniká nový veřejný port, databáze, token, provider poller nebo traffic writer.
Měření Jízdy zůstává vypnuté `shadow_only`. Rollback aplikace zachovává mazání
a retenční úklid měření. COP a iOS SDK musejí přijmout stejný kontrakt a zvlášť
ověřit skutečnou mobilní navigaci; SIM-only test není fyzická iPhone akceptace.
