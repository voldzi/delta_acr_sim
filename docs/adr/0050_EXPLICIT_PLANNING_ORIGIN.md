# ADR 0050: explicitní plánovací začátek mimo nepřesnou GPS

Status: **společně revidovaný zdrojový kontrakt, implementační kandidát**;
nenasazeno, bez nativní/telefonní akceptace. Aktivní source fragment je
`openapi/fragments/planning-origin-v1.openapi.json`; historický návrh 7d959…
zůstává zachovaný. Úplná closure evidence je společně potvrzený aditivní doplněk.
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

**Produktová mez první etapy:** ruční výběr již v Jízdě existuje a dřívější
ručně vybraný bod také skončil odmítnutím warning401. Samotná nová preview obálka
tedy není opravou routovatelnosti původní telefonní polohy ani veřejného vjezdu.
Její konkrétní přínos je zachování dosud ztracených metadat měření a vynucené
oddělení plánovacího účelu od navigační autority. To je bezpečnostní/kontraktní
zlepšení a explicitní ruční workaround, nikoli doložené splnění cíle „naplánovat
z domu“. Skutečná pomoc s přístupovým bodem zůstává neimplementovaná a schopnost
profile/direction-aware discovery není ověřená. Ani její návrh nesmí být vydáván
za nativní vyřešení chyby171/401. Před integrací musí společná revize výslovně
rozhodnout o omezené mezietapě. Společná produktová revize COP/Jízda následně
požaduje **asistované discovery jako povinnou podmínku splnění původního cíle**;
manual-only endpoint se nyní neimplementuje jako domnělá oprava. Dosavadní
neúspěšný pokus zůstává neúspěšným pokusem.

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

### Společný kontext: `planningOrigin.preview` (zatím bez HTTP cesty)

| Pole | Přesná navržená hodnota / typ |
| --- | --- |
| `version` | `sim-planning-origin-v1` |
| `purpose` | pouze `planning_preview` |
| `measuredAnchor.coordinate` | `{lat:number, lon:number}`; původní měření |
| `measuredAnchor.horizontalAccuracyM` | konečné číslo `>0`, nejvýše 5000 m pro telefonní kontext; není snap radius |
| `measuredAnchor.observedAt` | UTC ISO; stáří 0–900 s pro telefonní kontext, budoucí čas odmítnout |
| `measuredAnchor.accuracyAuthorization` | `full` nebo `reduced`; není oprávnění k vjezdu |
| `destination` | původní cílový bod; bez změny po výběru kandidáta |
| `vehicleProfile` | úplný aktuálně podporovaný mapped profil auta |
| `selection.coordinate` | uživatelem ručně zvolený plánovací bod `{lat,lon}` |
| `selection.source` | pouze `user_map_selection` |
| `selection.confirmed` | přesně `true`; vyjádření klientské volby, ne serverová atestace člověka |

Číselné hranice jsou **návrh**, musí projít společnou produktovou a výkonovou
akceptací a aktuálními fakty klienta. Přesnost i čas GPS jsou klientská tvrzení,
nikoli serverem ověřená poloha. Serverový rozpočet musí být nezávisle omezený.
Jízda doložila současnou klientskou politiku 0–900 s a do 5000 m a zachování
původního CLLocation; nynější wire převádí pouze souřadnice a ztrácí stáří/přesnost.
`approximate` může znamenat stáří NEBO hrubou přesnost, proto z bool nelze
rekonstruovat, který důvod nastal při incidentu. Nový kontext je zachycený
neměnný snapshot původního měření, nikoli nové měření vyvolané serverem.
Chybí-li či překročí-li metadata meze, nabídnout ruční volbu nebo uživatelsky
vyžádané nové měření, nikdy potichu spustit GPS. Užší budoucí limit musí mít
výslovnou kompatibilní chybu/reselection flow; nejde jej změnit jen na serveru.

Telefonní metadata smí nést pouze varianta `originContext.kind=phone_measured`.
Ruční/adresní původ je oddělená varianta `manual_point`, bez measuredAnchor
a bez smyšlené přesnosti/času GPS. Tato preview obálka nenahrazuje existující
normální požadavek z ručního bodu. Konkrétní discriminator/názvy doladí společná
JSON/OpenAPI revize, nikoli tiché přijetí dalších polí stávajícím endpointem.
Také starou poslední známou polohu lze použít výhradně po výslovné volbě jako
`manual_point` s původem `user_selected_last_known`, nikoli jako čerstvý měřený
anchor. Jde o plánovací bod, ne o důkaz aktuální přítomnosti telefonu.
Samotný ruční preview je pouze možná mezietapa, ne splnění původního cíle.
Uživatel již může zvolit ruční bod; explicitní preview z toho nesmí vytvořit
nové přístupové oprávnění. Discovery nepotřebuje výběrový token.
Použije se existující autentizované serverové spojení, bez nového tajemství.

### Povinná asistence pro původní cíl: `planningOrigin.candidates`

Tato operace je **povinnou podmínkou akceptace původního cíle**, ne hotová služba.
Kritická cesta: primární source evidence → společně revidované čistě syntetické
či veřejné fixture → omezená asistence → společná akceptace telefonu.
Bez konkrétní ověřené implementace nelze slibovat kompatibilitu kandidáta
s celým profilem. Kandidát nemusí být právním/trasovým proof; musí mít pravdivý
stav neověření a po explicitním výběru projít celým původním routovacím guardem.
Navržený rozpočet: nejvýše jeden omezený serverový průzkum kandidátů na požadavek,
nejvýše tři výsledky, žádné automatické routovací pokusy přes všechny kandidáty.
Průzkum nejvýše 500 m od plánovacího referenčního bodu, nezávisle na přesnosti
GPS. Přesnost 3 m na soukromém dvoře nesmí znemožnit nabídku silnice vzdálené
60 m; nejistota měření a uživatelem zvolená odchylka jsou dvě různé veličiny.
Tato mez omezuje jen serverové discovery, nikoli existující ruční volbu bodu
na mapě nebo snap následné trasy. Nepokrývá-li rozpočet situaci, nabídne ruční výběr nebo
čerstvější/přesnější měření; nesmí předstírat, že nejbližší bod je skutečná poloha.
Zastaralý nebo mimo-limitní anchor se neinterpretuje jako platná aktuální GPS.

Kandidát obsahuje pouze `candidateId`, souřadnici plánovacího bodu, odchylku
od anchoru, graph version a čas platnosti. Identifikátor slouží k UX korelaci,
není oprávnění. Je-li později nutné zabránit změně nabídky, použije se explicitní
vazba celého vstupu/profilu/grafu ve stávajícím mechanismu; nový klíč ani podpisová
služba nejsou předpokladem návrhu. Výběr kandidáta **není road/closure/legal proof**.
Neznámé přístupové oprávnění se označí výslovně, ne jako ověřený veřejný vjezd.
Existující `nearest-access` není pro tuto roli akceptovaný bez nové implementace
a testů profilu, směru, dostupnosti a vazeb na stejný dataset.

### Ověřená source capability Valhalla 3.8.3 (nikoli nativní test)

Primární [locate_action.cc](https://raw.githubusercontent.com/valhalla/valhalla/3.8.3/src/loki/locate_action.cc)
ř.15/40 načte costing a předá jej kandidátnímu vyhledávání. To je podklad pro
novou větev s plnými mapped costing options; současný SIM `requestValhallaLocate`
posílá pouze základní profil a není možné jej slepě převzít.

[search.cc](https://raw.githubusercontent.com/valhalla/valhalla/3.8.3/src/loki/search.cc)
ř.330/361/467 zpracovává protisměrné hrany odděleně a používá lehké
`Allowed(edge,tile,mask)`; heading/side filtrování přesouvá kandidáty do
`filtered_edges`. Bez měřeného relevantního směru se nevymýšlí heading ze směru
k cíli. Do nabídky se nepřebírají `filtered_edges` jako přijaté hrany.

[autocost.cc](https://raw.githubusercontent.com/valhalla/valhalla/3.8.3/src/sif/autocost.cc)
ř.313–319 ukazuje rozdíl oproti plnému route `Allowed` ř.385–449: kandidátní
filtr neprokazuje rozměrová/časová omezení celého profilu. Přijetí options není
důkaz jejich kompletního vyhodnocení. Nabídka proto výslovně nese
`profileValidation:not_checked`, `legalAccess:not_verified`, bez tvrzení průjezdu.
Po výběru se žádné z původních úplných routovacích kontrol nevypouští.

[locate_serializer.cc](https://raw.githubusercontent.com/valhalla/valhalla/3.8.3/src/tyr/locate_serializer.cc)
ř.175–205 vrací promítnutou souřadnici, vzdálenost, heading, dosah a directed
edge ID; lean ř.229–238 má projekci, ale ne všechna tato metadata. Nový SIM
parser musí z odpovědi vybrat jen nezbytná pole, ověřit čísla, vzdálenost,
deduplikaci a dataset; žádný surový verbose objekt, partner traffic či incident
se nepředává. Nejvýše tři seřazené plánovací body nejsou ověřené právní vjezdy.

Zdroje tedy podporují proveditelnost kandidátní asistence bez výměny enginu,
nikoli její hotovou funkčnost. Zatím neproběhl žádný nový locate/native request.
Fixture musí ověřit projekci do 500 m, směr, filtrování/nespolehlivé položky,
profile-preserving payload a následné odmítnutí rozměrových zákazů při plné trase.
Samostatný nový proof kandidáta není předpokladem; nevzniká tím autorita vjezdu.

### Zpracování `planningOrigin.preview`

Každý požadavek obsahuje celý aktuální vstup včetně explicitního výběru, profilu
a cíle. Změna vstupu znamená nový výpočet; žádné navázání na starou nabídku nebo
starý proof. Ruční souřadnice zůstává nedůvěryhodný vstup, nikoli serverový pokyn.
Před prvním await se pořídí nezávislý snapshot kontextu a celého vstupu.
Identita účtu/služby pochází pouze z ověřeného spojení COP, ne klientského userId.
Po každém asynchronním výpočtu se znovu ověří stáří, platnost, dataset a uzávěry;
COP/SDK po await ověří nezměněný request/account/profile/destination/context.
Změněný nebo mezitím prošlý kontext se nezobrazí jako aktuální preview.

Po výslovném potvrzení uživatelem server provede nejvýše jeden routovací výpočet
z plánovacího bodu, s původním profilem, stejnými guardy uzávěr, grafu, času,
geometrie, všech variant, 25m snapem, warning401 a limity jako běžná přijatá trasa.
Při neúspěchu žádná změna profilu, druhý kandidát ani přímý engine fallback.
Změna datasetu/uzávěr během výpočtu výsledek zneplatní.
Zákaz druhého kandidáta znamená zákaz automatické smyčky v jednom požadavku.
Uživatel smí po chybě výslovně vybrat jiný bod a odeslat nový omezený požadavek,
se zachováním celkových rate/concurrency limitů. Nesmí se skrytě vyžádat nová GPS.

Odpověď nese odděleně `measuredAnchor`, `planningOrigin`, `offsetDistanceM`,
`originUncertaintyM`, `connector:{state:unknown,navigable:false}` a výhradně
`purpose:planning_preview`, `navigationEligible:false`, `recordingEligible:false`.
Obsahuje původ/assessment ověřené části trasy, nikoli proof neznámého konektoru.
Nesmí se stát běžnou navigační trasou od GPS jen odstraněním těchto příznaků.
SDK/COP musí mít samostatný typ výsledku a odmítnout jej ve start-navigation API.
Existující SIM `mappedAssessment` používá `canonicalRoutingHash`, ne kryptografický
podpis. Hash není atestace původu. Nová obálka musí oddělenou verzí a doménou
vázat `purpose:planning_preview`, measured anchor, vybraný bod, úplný profil,
cíl, dataset, geometrii a platnost. Existující assessment v1 se nesmí vydávat
samostatně jako běžný navigační výsledek; COP/SDK verifier vyžaduje obálku a účel.
Pokud COP používá vlastní podepisování, změna musí účel přenést do jeho již
schváleného doménově odděleného proof; SIM nezavede ani nevypůjčí erasure/HMAC klíče.

## Přechod k navigaci, soukromí a provoz

Start navigace vyžaduje obvyklý čerstvý přesný měřený anchor a nový normální
routovací požadavek. Preview se nerecykluje do proof navigace.
**Samostatné GPS nahrávání bez navigace se nemění a nevyžaduje trasu.**
`recordingEligible:false` zde pouze zakazuje použít preview geometrii nebo
plánovací bod jako naměřené GPS/dobrovolné měření; neblokuje nezávislou funkci
nahrávání s jejími dosavadními oprávněními a pravidly kvality.
Ruční bod na mapě je další výslovná uživatelská volba, ne změna GPS autority.
Uložený plán uchovává plánovací bod, cíl, referenci auta a plánovací čas, ne
expirující proof či token jako autoritu k pozdější jízdě. Při odjezdu se znovu
ověří aktuální profil/oprávnění a spočítá nová trasa podle aktuálního měření.

Anchor a souřadnice jsou citlivý obsah: jen v paměti pro požadavek,
bez logování těla, query, GPS nebo uživatelských ID. Žádná historie pohybu.
Pokud cache, pouze krátká privátní a uživatelsky oddělená, se stejnými vstupy
v klíči a podporou odvolání; žádná sdílená cache soukromých kandidátů.
Výkonové limity a přesná vazba existujícího assessment/verifieru zůstávají
ke společné revizi. Žádné nové provider/GPS/OpenAI volání tento ADR neprovádí.

## Povinné negativní a integrační případy (dosud NEPROVEDENÉ)

- Chybějící souhlas/výběr, jiný uživatel/služba/profil/cíl/bod; klientský výběr
  nikdy neobchází existující ověření přístupu a celé trasy.
- Změna grafu/uzávěr, replay assessmentu po změně vstupu či smazání účtu.
- NaN/Infinity, neznámé klíče, neplatné souřadnice, záporná/0/nadlimitní přesnost,
  budoucí/stará GPS, neznámá accuracyAuthorization, klientský graph/ignore flag.
- Žádný kandidát v rozpočtu; soukromý/zakázaný vjezd; rozměrový zákaz,
  uzávěra, špatný směr, warning401, upstream171, smíšená/poškozená odpověď.
- Klientská změna cíle či profilu nesmí použít starý assessment; případné budoucí
  kandidátní ID neuděluje přístup ani nedovoluje vynechat nový výpočet.
- Žádný tichý retry při 429/503, vyčerpaném rozpočtu nebo výpadku engine/DB.
- Žádná záměna preview za navigation/recording; GPS anchor zůstane bitově stejný.
- Přesná GPS na soukromém pozemku a veřejný začátek mimo její uncertainty circle;
  uživatelská další volba po chybě versus zakázaná automatická smyčka;
  nezávislé nahrávání bez navigace; uložený plán bez zachované routovací autority.
- Původní klientské meze 900 s/5000 m, hranice a překročení po await; rozdíl
  staré a hrubé GPS, manual/address bez měřených metadat; změna účtu/profilu/
  cíle/kontextu během await a žádné skryté vyžádání nové GPS.
- Souběh více aplikací: uživatelská izolace, centralizované engine limity,
  cancellation, expirace a žádný násobný provider polling.
- Syntetické geometrierestrikční testy, poté společná fyzická akceptace iPhonu.

Implementace, rozšíření závazného OpenAPI, negativní testy a nový proof/verifier
se připraví až po společné revizi tohoto kontraktu. Žádná produkční změna nyní.
