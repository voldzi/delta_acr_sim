# ADR 0032: Běžné trasy s částečným revidovaným seznamem uzavírek

Datum: 2026-10-03. Stav: implementováno; aktivace vyžaduje zdrojový a engine test
a nezávislou validaci COP. Nesuperseduje ADR 0031.

## Rozhodnutí

Běžná automobilová větev může mít `knownClosures` s `coverage=incomplete`.
Není to strict `assessment` ani příslib úplného právního nebo geografického
pokrytí. Stávající `trip` jde vždy nejprve do strict větve; nikdy se nesnižuje
na tuto cestu. Strict zůstává samostatně vypnutý.

Vlastník jednotlivě reviduje aktuální oficiální TEC událost a přesnou geometrii
aktivního grafu. Review template je soukromý, transformovaný, mimo veřejný Git;
obsahuje hash celé relevantní sémantiky, přesný dataset, OSM way, scope basis,
review time a polygon. Nemá osobní údaje ani surovou licencovanou publikaci.
Současný úplný TEC snapshot sdílí stávající poller, conditional requests,
in-flight deduplikaci a persistentní kvótu. Další odběr/poller nevzniká.

Podporuje se skutečný `sourceDirection=both`. Výjimečně lze u individuálně
ověřeného oficiálního uzavření CELÉHO objektu použít konzervativní zákaz obou
směrů při `sourceDirection=unknown`. Odpověď uvádí
`enforcementReason=conservative_whole_structure_avoidance`; nejde o domyšlený
směr zdroje, může vzniknout delší objížďka. Nikdy se tím nepřepisuje explicitní
jednosměrnost, omezení druhu vozidla či jízdního pruhu. Fuzzy line sama není
geometrie uzavřené hrany. Směrový TMC/OpenLR mapping má vlastní akceptaci.

Engine obdrží všechny revidované polygons, ne jen OD koridor; všechny native
varianty/legs (včetně nadpočetných) a finální geometrie se ověří proti uzavírkám.
Snap nejvýše 25 m. Není route cache ani unconstrained fallback. Chyba zdroje,
neověřená změna grafu/sémantiky, revokace, deadline nebo engine warning odmítne celý
výsledek. Čerstvé potvrzení úplného snapshotu platí nejvýše 10 minut; event
onset ani staré datum editace není source observation. Absence ve čerstvém
full snapshotu znamená odvolání té konkrétní události, ne úplnost ČR.

### Mechanická návaznost na nový graf

Pro tentýž individuálně schválený objekt lze v soukromém template výslovně
schválit `graphProbe` (v1, dvoubodová centerline a OD mimo objekt). Při zjištění
nového datasetu stávajícím routovacím dotazem se ověří aktuální úplný zdroj,
nezměněný semantic hash, přesná engine verze a stáří grafu. Následuje map_snap
stejného OSM way v obou směrech, baseline průjezd a vynucená objížďka. Každá
constrained native varianta musí mít úplné indexované manévry, neprotínat
schválený polygon a v nezávislém edge_walk nesmí obsahovat schválený OSM way
(ani mimo polygon). Konečné source/graph/file fences odmítnou souběžnou změnu.

Pilot je omezen na jeden objekt, konvexní čtyřúhelník, centerline do 250 m,
OD 50–2000 m, native trasy do 20 km a nejvýše tři varianty v každém směru.
Engine probes mají společný deadline nejvýše 10 s, jednotlivý request 5 s;
sdílený source fetch stále používá existující kvótu a timeout. Souběžné probes
se deduplikují; selhání se pro stejný vstup opakuje nejdříve za 60 s.
V RAM se drží nejvýše čtyři vazby, nikdy routy nebo zdrojová data.

Schvalovací soubor se nepřepisuje. Výsledek je pouze mechanická RAM vazba
stejné revize/geometrie na konkrétní graf; změna zdroje, OSM identity,
geometrie nebo chybějící anchors vyžaduje lidskou revizi. Restart procesů
vyžádá novou kontrolu. Nepřibývá scheduler, provider poller ani automatické
schválení nových uzavírek. Neúspěch vrátí 503 bez unconstrained fallbacku.

## Dopady a bezpečnost

Vyšší dostupnost bez úplného pokrytí se nesmí vydávat za bezpečný průjezd,
ověřené vehicle limits, last-mile oprávnění ani zlepšenou přesnost ETA.
Hash vazby dokládají integritu odpovědi, nikoli pravdivost zdroje. COP nezávisle
ověřuje request identity, každou raw variantu/feature, hash, deadline,
graph/revision/engine a směr+reason. Bez toho neukazuje accepted stav.

Změna nezasahuje live traffic writer, databázi měření, GPS, secrets, SDK ani
síť. Nasazení a návrat viz runbook 18; oba příznaky jsou nezávislé, výchozí OFF.

## Primární zdroje

- [Valhalla exclude_polygons](https://valhalla.github.io/valhalla/api/route/api-reference/)
- [TEC protokol a úplné snapshoty](https://tpeg.dopravniinfo.cz/technical/protocol)
- [TEC/GLR oficiální XSD](https://github.com/tamtamresearch/x-format_cz-ndic_tpeg2-tec-v0.1)
- [OSM atribuce a licence](https://www.openstreetmap.org/copyright)
