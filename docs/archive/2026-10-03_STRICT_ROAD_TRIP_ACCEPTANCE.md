# Přísný routing — implementace a dílčí akceptace 3. 10. 2026

## Stav dodávky

Větev `codex/jizda-routing-safety`, navazuje na návrh `10a7cdd`.
Implementace je opt-in, **nenasazená**, `ROUTING_STRICT_TRIPS_ENABLED=false`.
Neproběhlo přepnutí COP, mobilní aplikace, síťové ani datové změny produkce.
Autoritativní úplný snapshot uzavírek není zavedený; ukázkový snapshot nesmí
být publikován jako skutečný zdroj. Měření Jízdy zůstávají `shadow_only`/off.

## Místní a společné ověření

- Celý SIM: typecheck a build prošly; skeleton a závazný OpenAPI prošly
  (143 paths, 245 schemas). Standardní běh testů nepoužívá skutečnou PostgreSQL;
  šest oddělených DB testů zůstává skipped, nikoli pozitivní důkaz tohoto běhu.
- Regrese: 361 testů prošlo v závěrečném celorepozitářovém běhu; SDA má
  218 passed / 6 skipped, včetně 26 nových routing testů.
- SDA: validace celého immutable requestu, canonical SHA-256, rozměry a kg→t,
  car→auto / commercial_truck→truck, waypoint pořadí a leg snap ≤25m,
  per-variant geometry hash a uzavírky mimo přímý OD koridor.
- Odmítnutí nepodporovaného trailer/axle/planned departure/entrance a fire/flood,
  chybného či chybějícího zdroje, engine warning/clamp, fallbacku, starého grafu,
  změny/revokace/směru/expirace uzavírky během výpočtu a změny grafu.
- Legacy fallback už neoznačuje zahozený engine exclusion jako aplikovaný.
- Structured roundabout phase pochází z typů 26/27, typ 25 není roundabout;
  žádné dopočtené výjezdy ani domnělé bearings.
- Skutečný SIM HTTP handler s injektovaným syntetickým enginem a closure
  snapshotem vrátil dvě varianty. COP jej nezávisle ověřil přes vlastní
  verifier, adapter a autentizovaný HTTP handler: 200, dvě varianty, shodné
  canonical hashes, zachované odchozí flags; anonymous 401 bez dalšího fetch.
  Fixture pracuje s testovacím časem `2026-10-03T12:00:00Z`, nikoli živou platností.
  Tento test neprokazuje skutečné uzavírky nebo fyzický iPhone.
  Všech devět sdílených schemas se shoduje s COP po předepsaném OpenAPI
  prefixování `RoadTrip`; rozdíl obalu či formátování není rozdíl kontraktu.

## Skutečná Valhalla — read-only kompatibilita

`scripts/check-valhalla-strict-compatibility.mjs` proti internímu portu 8002:

- `/status`: engine `3.8.3`, tileset `1790679143`;
- auto i truck přijaly čtyři parametry vozidla, current departure, via
  `break_through`, snap 25m, dvě legs; HTTP 200, žádné clamp warning;
- syntetický polygon vložený pouze do jednotlivého requestu nejprve nezávisle
  protínal baseline trasu; forward a reverse výpočet jej objel, všechny vrácené
  geometrie byly zkontrolované mimo polygon (v obou případech jedna varianta);
- graf po testu nezměněný. Žádný zápis grafu, traffic overlay či globální uzavírky.

Jde o kompatibilitu payloadu a geometrickou kontrolu jednoho umělého případu,
**ne** přijetí authoritative closure coverage, skutečných výškových/hmotnostních
limitů, hgv zákazu, tunelu/můstku nebo přesnosti kruhového objezdu.
Valhalla `hgv_no_access_penalty=43200` je přesný sentinel pro zachování truck
access mask, nikoli povolení průjezdu za dvanáctihodinovou penalizaci:
[TruckCost 3.8.3](https://raw.githubusercontent.com/valhalla/valhalla/3.8.3/src/sif/truckcost.cc),
[kMaxPenalty](https://raw.githubusercontent.com/valhalla/valhalla/3.8.3/valhalla/sif/dynamiccost.h).
Ostatní volby se opírají o konkrétní
[AutoCost 3.8.3](https://raw.githubusercontent.com/valhalla/valhalla/3.8.3/src/sif/autocost.cc)
a [oficiální API](https://valhalla.github.io/valhalla/api/route/api-reference/).

## Produkce — pouze přečtený stav

Host `docker.home.cz`, checkout `dba75d609f4db3f398399e1178346a10c425a9f5`.
SDA image `sha256:00b842865ef8d31610a57e69fcfd34c65a9a8f31c9b9731a73c16c5ea0a7f882`,
runtime z měření `b3e94c9b02e480268fd8b51c284069602b9fa2c1` podle předchozího
nasazení; running/healthy, HostConfig.PortBindings `{}`, live/ready 200.
Strict flag false, driver intake false, revocation true.
Readiness byla zopakována na správném portu 4020; první pokus na 3000
nebyl úspěšný a není zde prezentován jako důkaz readiness.

## Zbývající brány a návrat

1. Důvěryhodný publisher, geografická revize a úplnost deklarované oblasti
   uzavírek, s přesnou vazbou na graf a časovou platností.
2. Skutečné pod/nad vehicle restriction, hgv/access, closure bridge v obou
   směrech, všechny varianty a skutečný kruhový objezd; pouze omezený testovací
   pilot po společném schválení. Jednosměrné uzavírky v1 nepodporuje.
3. Sestavení a test obrazu v odděleném runtime, potom výslovné schválení
   produkčního pilota; zachovat všechny Compose overlays X5 a měření.
4. Akceptace COP/SDK/Jízda na reálném iPhonu před přepnutím klienta.

Rollback: strict=false, přijatý předchozí SDA obraz, caller nadále fail-closed;
nezahazovat trip nebo uzavírky a nepřecházet na MapKit/legacy fallback.
Příjem dobrovolných jízd a ETA promotion jsou samostatné brány.
Chroma reindex byl zkusen, server nebyl dostupný; index není potvrzen aktualizovaný.
Viz [runbook 18](../runbooks/18_STRICT_ROAD_TRIP_ROUTING.md).
