# ADR 0050: explicitní plánovací začátek mimo nepřesnou GPS

Status: **návrh ke společné revizi SIM–COP–Jízda**, neimplementováno, nenasazeno.
Neopravňuje k dalším soukromým dotazům, změně snap tolerance ani zapnutí navigace.

## Důvod a doložená hranice

Jediný pokus 29.10.2026 s původní přibližnou polohou a uloženým autem skončil
`ROUTING_LOCATION_NOT_ROUTABLE`, stage `native_request`, costing `auto`,
requested mode `none`, jedna požadovaná varianta, žádná vrácená trasa.
Warning401 nebyl vrácen; geometrie ani uzávěry následné trasy nebyly ověřeny.
Valhalla HTTP400/číselný171 v této větvi neurčuje index selhávajícího bodu.
Není tedy doloženo, že selhal právě start, ani že by změna času problém opravila.

Aktuální známé uzávěry omezují radius/search_cutoff i následný snap na nejvýše
25 m pro všechny body. Přibližná GPS není příslibem přítomnosti řidiče na silnici.
Samotné zvětšení tolerance, nearestAccess nebo přesunutí GPS není přijatelné řešení.

## Rozhodnutí navržené pro společnou revizi

Zavést oddělený kontrakt `sim-planning-origin-v1`, nikoli skrytou změnu existující
`routing/route`. Stávající normální navigační a strict-road kontrakty se nemění.
Nové návrhové operace níže **nejsou existující endpointy** a do závazného
`openapi/openapi.json` se přidají až po schválení návrhu společně s implementací.

Jízda uchová nezměněnou naměřenou polohu včetně stáří a přesnosti. Plánovací
začátek je samostatný bod vybraný uživatelem. Trasa začne tímto bodem, nikoli
naměřenou polohou. Úsek mezi nimi je neznámý, ne navigovatelný spojovací úsek.
Ani úspěšný preview není povolením vjezdu nebo zárukou fyzické průjezdnosti.

## Navržený wire kontrakt Jízda → SDK → COP → SIM

Všechny objekty mají `additionalProperties:false`; konečná čísla a platné
souřadnice jsou povinné. COP přenese existující službově ověřenou identitu,
request-scoped UUID a nezměněný úplný `sim-mapped-road-profile-v1`.
Klient nesmí nastavit `ignore_*`, serverové limity, dokazující token ani graph ID.

### 1. `planningOrigin.candidates` (název operace, zatím bez HTTP cesty)

| Pole | Přesná navržená hodnota / typ |
| --- | --- |
| `version` | `sim-planning-origin-v1` |
| `purpose` | pouze `planning_preview` |
| `measuredAnchor.coordinate` | `{lat:number, lon:number}`; původní měření |
| `measuredAnchor.horizontalAccuracyM` | konečné číslo `>0`, nejvýše 3000 m |
| `measuredAnchor.observedAt` | UTC ISO; stáří 0–300 s, budoucí čas odmítnout |
| `measuredAnchor.accuracyAuthorization` | `full` nebo `reduced`; není oprávnění k vjezdu |
| `destination` | původní cílový bod; bez změny po výběru kandidáta |
| `vehicleProfile` | úplný aktuálně podporovaný mapped profil auta |

Číselné hranice jsou **návrh**, musí projít společnou produktovou a výkonovou
akceptací. Nejvýše jeden omezený serverový průzkum kandidátů na požadavek,
nejvýše tři výsledky, žádné automatické routovací pokusy přes všechny kandidáty.
Průzkum nejvýše 500 m od anchoru a nikdy více než deklarovaná přesnost.
Nepokrývá-li tento rozpočet nejistotu, odpověď požaduje ruční výběr začátku nebo
čerstvější/přesnější měření; nesmí předstírat, že nejbližší bod je skutečná poloha.
Zastaralý nebo mimo-limitní anchor se neinterpretuje jako platná aktuální GPS.

Kandidát obsahuje pouze `candidateId`, souřadnici plánovacího bodu, odchylku
od anchoru, graph version, čas platnosti a podepsaný krátkodobý výběrový token.
Token je svázán se službou/uživatelem, hashem celého vstupu, úplným profilem,
konkrétním bodem a datasetem. Výběr kandidáta **není road/closure/legal proof**.
Neznámé přístupové oprávnění se označí výslovně, ne jako ověřený veřejný vjezd.
Existující `nearest-access` není pro tuto roli akceptovaný bez nové implementace
a testů profilu, směru, dostupnosti a vazeb na stejný dataset.

### 2. `planningOrigin.preview`

Stejný vstup jako výše + přesně `selection:{candidateId, selectionToken,
confirmed:true}`. Žádná klientská změna souřadnice, profilu, cíle ani grafu
bez nového výběru. Výběrový token nejvýše 120 s, samostatné serverové tajemství
a distribuce tajemství nejsou tímto návrhem schváleny.

Po výslovném potvrzení uživatelem server provede nejvýše jeden routovací výpočet
z plánovacího bodu, s původním profilem, stejnými guardy uzávěr, grafu, času,
geometrie, všech variant, 25m snapem, warning401 a limity jako běžná přijatá trasa.
Při neúspěchu žádná změna profilu, druhý kandidát ani přímý engine fallback.
Změna datasetu/uzávěr během výpočtu výsledek zneplatní.

Odpověď nese odděleně `measuredAnchor`, `planningOrigin`, `offsetDistanceM`,
`originUncertaintyM`, `connector:{state:unknown,navigable:false}` a výhradně
`purpose:planning_preview`, `navigationEligible:false`, `recordingEligible:false`.
Obsahuje původ/proof běžné ověřené části trasy, nikoli proof neznámého konektoru.
Nesmí se stát běžnou navigační trasou od GPS jen odstraněním těchto příznaků.
SDK/COP musí mít samostatný typ výsledku a odmítnout jej ve start-navigation API.

## Přechod k navigaci, soukromí a provoz

Start navigace/záznamu vyžaduje obvyklý čerstvý přesný měřený anchor a nový
normální routovací požadavek. Preview se nerecykluje do proof navigace.
Ruční bod na mapě je další výslovná uživatelská volba, ne změna GPS autority.

Anchor, token a souřadnice jsou citlivý obsah: jen v paměti pro požadavek,
bez logování těla, query, tokenu, GPS nebo uživatelských ID. Žádná historie pohybu.
Pokud cache, pouze krátká privátní a uživatelsky oddělená, se stejnými vstupy
v klíči a podporou odvolání; žádná sdílená cache soukromých kandidátů.
Konkrétní kryptografická implementace, výkonové limity a správa klíčů zůstávají
samostatně ke schválení. Žádné nové provider/GPS/OpenAI volání tento ADR neprovádí.

## Povinné negativní a integrační případy (dosud NEPROVEDENÉ)

- Chybějící souhlas/výběr, podvržený token, jiný uživatel/služba/profil/cíl/bod.
- Expirovaný token, změna grafu/uzávěr, replay po změně či smazání účtu.
- NaN/Infinity, neznámé klíče, neplatné souřadnice, záporná/0/nadlimitní přesnost,
  budoucí/stará GPS, neznámá accuracyAuthorization, klientský graph/ignore flag.
- Žádný kandidát v rozpočtu; soukromý/zakázaný vjezd; rozměrový zákaz,
  uzávěra, špatný směr, warning401, upstream171, smíšená/poškozená odpověď.
- Klientská změna cíle či profilu po nabídnutí kandidátů nesmí použít starý token.
- Žádný tichý retry při 429/503, vyčerpaném rozpočtu nebo výpadku engine/DB.
- Žádná záměna preview za navigation/recording; GPS anchor zůstane bitově stejný.
- Souběh více aplikací: uživatelská izolace, centralizované engine limity,
  cancellation, expirace a žádný násobný provider polling.
- Syntetické geometrierestrikční testy, poté společná fyzická akceptace iPhonu.

Implementace, rozšíření závazného OpenAPI, negativní testy a nový proof/verifier
se připraví až po společné revizi tohoto kontraktu. Žádná produkční změna nyní.
