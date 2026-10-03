# 18. Přísný routing Jízda–COP–SIM

## Výchozí stav a nasazení

`ROUTING_STRICT_TRIPS_ENABLED=false`; nová cesta je opt-in, běžný klient se
automaticky nepřepíná. Žádný nový endpoint, port, službový token ani síť.
Přísná větev nesmí přejít na legacy request při 400/422/502/503.
Použít existující autentizovaný COP adapter, ne mobilní přístup do SIM.

Po zveřejnění konkrétní revize sestavit jen situation-data-api s OCI revision,
ověřit obsažený `openapi/fragments/road-trip-v1.schemas.json`, pak v odděleném
testovacím runtime ověřit profiles.capabilities, validaci, syntetické uzavírky,
dvě varianty a chyby. Produkční pilot vyžaduje zvláštní schválení a společné
testy skutečné křižovatky, bridge closure a pod/nad vehicle restriction.
Při recreatu zachovat všechny existující Compose overlays včetně X5 a měření;
nerecreate jiných služeb ani Docker daemonu. Měření zůstanou shadow_only/off.

## Konfigurace a důvěryhodný closure publisher

- `ROUTING_STRICT_TRIPS_ENABLED`: explicitní opt-in, výchozí false.
- `ROUTING_STRICT_ENGINE_VERSIONS`: CSV přesných nezávisle přijatých verzí,
  výchozí prázdné. Samotné `3.8.3` není testovací důkaz.
- `ROUTING_REVIEWED_CLOSURES_FILE`: absolutní read-only cesta v kontejneru,
  výchozí prázdná. Nezaměňovat s cache dopravních rychlostí.

Publisher je odpovědností provozního vlastníka dat, ne mobilního klienta.
Zdroj se publikuje atomickou výměnou celého JSON souboru s revizí; používat
read-only mount celého adresáře, aby atomická výměna nebyla uvězněna inode
jednoho bind-mounted souboru. Rozšíření mountu není součástí tohoto nasazení.
Bez doložené licence/původu a geografické revize se source nesmí aktivovat.
Neinterpretovat speed=0 nebo SRTI bod automaticky jako uzavřenou hranu.

Přesná struktura souboru `sim-reviewed-road-closures-v1`:

```json
{
  "version": "sim-reviewed-road-closures-v1",
  "revision": "synthetic-fixture-only-1",
  "routingDataset": {
    "version": "sim-routing-2026-09-29-1790679143",
    "builtAt": "2026-09-29T10:52:23.000Z"
  },
  "observedAt": "2026-10-03T11:59:00Z",
  "validUntil": "2026-10-03T12:10:00Z",
  "coverage": "authoritative_reviewed_snapshot",
  "bbox": {"west": 14, "south": 50, "east": 15, "north": 51},
  "closures": [{
    "id": "SYNTHETIC-NOT-A-REAL-CLOSURE",
    "status": "active",
    "direction": "both",
    "validFrom": "2026-10-03T11:00:00Z",
    "validUntil": "2026-10-03T12:08:00Z",
    "polygon": [[14.49,50.09],[14.51,50.09],[14.51,50.11],[14.49,50.11],[14.49,50.09]],
    "source": {"authority": "synthetic-test", "reference": "fixture-only", "reviewedAt": "2026-10-03T11:58:00Z"}
  }]
}
```

Časy a dataset v příkladu jsou ilustrativní a nesmějí se kopírovat jako aktuální
záznam. `builtAt` musí být přesně aktuální `/status` datum, nikoli tento příklad.
Každý klíč v uvedené struktuře je povinný, žádné další. Revoked záznam ponechává
stejné pole a má `status=revoked`. Směr forward/backward lze zapsat, ale aktivní
takový záznam znamená 422, ne selektivní podporu. Expirující/future closure
zkracuje route.validUntil. Prázdný seznam není důkaz neexistence uzavírek:
publisher musí potvrdit celou deklarovanou oblast v časovém okně.

Limity: soubor ≤1MiB, ≤128 closures, celkem ≤4096 souřadnic, 4–256 na uzavřený jednoduchý
ring, bez děr/self-intersection, snapshot platnost ≤15min. Při překročení se
odmítne CELÝ snapshot, nic se neodřízne. Provenance obsahuje authority/reference/
reviewedAt; runtime ověří strukturu/čas, ne věrohodnost autority. Soubor nesmí
obsahovat osobní údaje. Budoucí directed-edge mechanismus má vlastní akceptaci.

## Vynucení a návrat

Graf nesmí být starší 10 dní ani datovaný do budoucna. Build time neprokazuje
aktuálnost každého OSM atributu. Snap ≤25m pro každý ordered waypoint a všechny
varianty. Via používá break_through, stop break; bez optimalizace/U-turn na via.
Engine exclusion polygons i následná kontrola celé geometrie platí v obou
směrech, včetně protínajícího segmentu bez vertexu uvnitř polygonu.
Route validUntil je nejdřívější closure/snapshot/graph-freshness deadline.
Každý další dotaz/reroute znovu čte zdroj a ověří graf; žádná strict cache.
Engine warning včetně clamp/omission zneplatní všechny varianty. Strict avoid
`fire`/`flood` je zatím 422, nikoli tiché vynechání bezpečnostního požadavku.

Pouhé odmítnutí intersecting varianty není důkaz, že engine vždy dokáže najít
objížďku. Shared tests používají syntetický engine; živý engine/OSM restriction
test a přesnost konkrétního kruhového objezdu zůstávají společnou akceptací.

Návrat: vypnout strict flag a vrátit přijatý SDA obraz; neměnit DB/GPS/secrets
ani traffic archive. COP/SDK musí přísné požadavky dál odmítat, pokud schopnosti
chybí; nikdy neodebírat trip/vehicle/closure requirement pro vynucení úspěchu.
