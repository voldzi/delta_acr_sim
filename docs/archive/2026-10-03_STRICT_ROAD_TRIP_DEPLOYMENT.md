# Road-trip: očištěný ověřovací záznam 3. 10. 2026

Záznam neobsahuje hosty, IP, mount UUID, názvy interních sítí, image IDs,
secrets ani přesné provozní kroky. Podrobný záznam zůstává odděleně operátorovi.

## Ověření kontraktu

- Připravenost a živost HTTP 200.
- Profiles vracejí `sim-road-trip-capabilities-v1`, strict vypnutý.
- Validní strict požadavek se odmítá 422 `ROUTING_SAFETY_UNSUPPORTED`.
- Neplatný numerický parametr vrací 400.
- Běžný požadavek vrací 200 a `engine_route`, ne náhradní přímou čáru.
- Společný COP adapter ověřil stejné schopnosti a rozlišení strict/běžné větve.
- Oddělený obraz bez sítě ověřil načtení schema assetu a výchozí odmítnutí.
  Aktivovaná testovací cesta s injektovaným syntetickým statusem a chybějícími
  uzavírkami vrátila 503. To není aktivace skutečného zdroje.
- Dobrovolný příjem měření zůstává vypnutý; autentizace a validace mazání
  zachované. Testy nevytvářely skutečné příspěvky.

## Datový blocker přísného režimu

Existující mapový kontrakt událostí neposkytuje současně ověřenou úplnost
oblasti, skutečnou platnost/revokaci, směr a vozovku a vazbu na konkrétní graf.
Reprezentativní bod nebo referenční čára nestačí k automatické publikaci
`authoritative_reviewed_snapshot`. Prázdný seznam není potvrzení průjezdnosti.
Rychlostní měření ani nulová rychlost nedokazují právní/fyzickou uzavírku.

Navazující postup:

1. Pro review použít incident/TEC semantics, ne flow rychlosti; zachovat
   originální version, cancel, validity, effect/cause a location referencing.
2. Ověřit skutečný rozsah úplnosti a oprávnění konkrétního poskytovatelského feedu.
   DATEX II SituationPublication je kandidátní formát, nikoli důkaz přístupu.
3. Geograficky zkontrolovat omezenou oblast, dotčené vozovky a všechny relevantní
   aktivní uzavírky; jeden potvrzený most není úplnost celé oblasti.
4. Publisher musí splnit graph-bound kontrakt a krátkou platnost; chybějící
   update nebo coverage znamená odmítnutí, ne automatický prázdný snapshot.
5. Teprve po skutečných engine restriction tests a společné mobilní akceptaci
   aktivovat pilot. Jednosměrné uzavírky vyžadují další směrový mechanismus.

Reference: [DATEX II road closures profile](https://docs.datex2.eu/v3.3/reference_profiles/rrp/rtti/drd-1-road-closures/index.html),
[SituationPublication](https://docs.datex2.eu/v3.1/level2user/situationPublication.html).
Podrobný runtime stav nelze z tohoto očištěného záznamu rekonstruovat.
