# Acceptance criteria

**Status:** Baseline dokumentace

## Funkční

- SIM běží samostatně mimo COP
- UI umožní vytvořit, spustit, pozastavit a zastavit scénář
- SIM generuje aircraft, UAV a missile tracks
- SIM umí dry-run
- všechna data jsou SYNTHETIC
- fault injection je dostupný
- health/metrics endpointy fungují

## AI

- provider abstraction pro OpenAI, Codex, local LLM a mock
- AI draft validovaný proti JSON Schema
- human confirmation před spuštěním
- zakázané požadavky odmítnuté a auditované
- externí AI lze vypnout

## Integrace

- sourceSystemId
- idempotency key
- retry/backoff
- batch sending
- 401/403/409/422/429/503 handling
- revokace zdroje bez změny kódu

## Výkonnost

- 1 000 aktivních tracků MVP
- 1 000 zpráv/s lab režim
- queue neztratí data při krátkodobém výpadku
- restart neztratí uložené scénáře
- SIM web splní bundle budget `pnpm build:budget`
- operations dashboard chrání interní provider dotazy timeoutem a limitem velikosti odpovědi `SIM_OPERATIONS_PROVIDER_MAX_RESPONSE_BYTES`

## Produkční routing dataset

- Valhalla kandidát se staví mimo aktivní produkční release
- `admins.sqlite` obsahuje ISO CZ, DE, PL, SK, AT a HU
- route, locate, isochrone a elevation projdou pro všech šest zemí s tvrdým
  `search_cutoff` a kontrolou skutečné snap vzdálenosti
- smíšené časy Geofabrik snapshotů nevytvoří duplicitní verze OSM objektů ve
  finálním extractu
- vadný kandidát nezmění `current`
- vynucené selhání aktivace obnoví a ověří předchozí release
- systemd timer je enabled a poslední pokus i úspěch jsou dohledatelné

### Jediná varianta plánované mapped automobilové trasy

Syntetická kontrola 2026-10-28 v `known-road-closures.test.ts` porovnává celý
nativní požadavek stejného profilu a uzávěr pro `alternatives: 1` a `3`.
Lišit se smí pouze `alternates: 0` versus `2`. Profil včetně rozměrů a hmotnosti,
`costing: auto`, všechny `ignore_*: false`, geometrie vyloučených uzávěr,
`shortest: false`, tolerance i ostatní volby zůstávají stejné. Vstup se nemění.
Varování 401 musí i pro jedinou variantu skončit ochrannou 422, bez opakování
nativního dotazu či fallbacku. Tato kontrola nemění runtime ani API kontrakt.

Příkaz `pnpm --filter @csm-sim/situation-data-api exec vitest run
test/mapped-road-profile.test.ts test/known-road-closures.test.ts` prošel:
116/116 testů (24 profilů + 92 uzávěr/routování). Veškerý upstream je nahrazen
syntetickými odpověďmi. Test potvrzuje serializaci a bezpečnostní podmínky,
nikoli vyřešení konkrétní trasy z přibližné polohy telefonu. Opravené chování
klienta vyžaduje samostatné ověření na skutečném telefonu bez tichého posunu
polohy, vypuštění profilu, zvýšení tolerance nebo aktivace navigace.

Pro tento krok nebyl dostupný lokální obraz Valhally ani izolovaný skutečný
český graf: srovnání nativního výsledku veřejné adresy s jednou/třemi variantami
neproběhlo. Žádný produkční požadavek nebyl kvůli těmto testům opakován.
Varování 401 je ve zdroji Valhalla 3.8.3 indikátorem druhého průchodu hledání;
samo neurčuje porušený zákaz ani původ/cíl. Viz přesný upstream
[get_path, commit a60c7cb](https://github.com/valhalla/valhalla/blob/a60c7cbfc83e073f50887cd27e0109d02e6b64e5/src/thor/route_action.cc#L424-L475).

## Kvalita verze 1.0

### Omezená diagnostika routování — kandidát zdroje

`routing-diagnostics.test.ts` ověřuje vypnutý/expirující režim, maximálně deset
minut, šestnáct chyb celkem, nezávislé monotónní vypršení, přesné UUID, numerické
kódy a stropy, negativní canary pro soukromý text i extra pole a neovlivnění
chyby selháním loggeru. `known-road-closures.test.ts` navíc ověřuje dvě různá
UUID při jediném sdíleném výpočtu s nezměněným payloadem, korelaci HTTP obou
endpointů bez změny veřejné chyby a `closureGeometryValidated:false` při vadné
geometrii nebo průniku uzávěrou. Společně s mapped-profile testy: 136 lokálních
syntetických kontrol, upstream nahrazený mocky. Celá sada služby: 774 prošlo,
šest PostgreSQL opt-in kontrol přeskočeno bez samostatné testovací DB URL.
Čistý zdroj před změnou byl také zkompilován a shoduje se se všemi 57 soubory
aktuálního obrazu 9f0a (jména, velikosti, SHA); kandidát mění jen tři JS soubory
a přidává jediný diagnostický JS modul. Přesný důkaz je v
[baseline receipt](receipts/sim-routing-diagnostics-baseline-20261028.json).
To není aktivace okna, zjištění
skutečného algoritmu ani oprava konkrétního telefonu. Detailní kontrakt a Root
akceptace jsou v [runbooku 13](../runbooks/13_PERFORMANCE_OPERATIONS.md).

### Navazující nativní plán implicitního „nyní“ — dosud neprovedený

Toto je **samostatný plán**, nikoli součást diagnostického obrazu 09cd702,
aktivace změny významu odjezdu nebo důkaz opravy soukromé trasy. Nedostupnost
obrazu na Macu neznamená nedostupnost na serveru: Root má nejprve určit přesný
host a již přítomné immutable ID skutečného obrazu Valhalla 3.8.3. Žádný pull.

Pořadí evidence → případná oprava:

1. Dokončit Rootem schválený diagnostický build a jeho container-snapshot fence.
   Krátké provozní okno až s vyřešenou retencí a připraveným telefonem. Pokud
   skutečný požadavek již uvádí `depart_now`, nelze implicitní nyní vydávat za
   jeho opravu. Při chybějícím důvodu multipass zůstává konkrétní příčina unknown.
2. Root před spuštěním schválí přesné image ID, hashe runneru/generátoru/plánu,
   argv, mounts, rozpočty a úklid. Pracovní adresář jen jedinečný root-owned
   0700 pod `/srv/x5-production/cache/csm-sim/`; UUID musí být
   `2f93f595-b61b-4eea-9054-7afa9b275b5b`, samostatný mount a dost místa podle
   čerstvého Root rozpočtu. Pokud obraz a X5 nejsou na stejném hostu, samostatně
   schválit přesný přesun veřejného obrazu; nepoužít root disk jako tichý fallback.
3. Použít stávající `generate-mapped-profile-test-pbf.py`,
   `mapped-profile-engine-plan.mjs` a `assert-mapped-profile-engine.py` jako
   základ: 52 syntetických nativních případů, nikoli mocky. Stávající shell runner
   **nespouštět beze změny**: neověřuje X5/custody, volí jméno podle PID, maže
   dočasná data a explicitně nastavuje chybějící admin/timezone SQLite. Tato
   konfigurace není důkaz CET/CEST. Nový úzký testovací runner musí být předem
   zmrazen a zkontrolován Rootem, ne privilegovaně improvizován za běhu.
4. Dva oddělené malé syntetické grafy (stejné vymyšlené body, žádná poloha
   telefonu): s ověřenou Europe/Prague timezone a bez ní. Existující veřejné
   timezone/admin podklady jen po Rootem ověřeném přesném path/hash a kopii do
   jobu; žádný široký produkční volume mount nebo zápis do živých tiles/traffic.
   Před vyhodnocením ověřit, že importer skutečně vytvořil očekávané restriction
   a timezone údaje; „tag nebyl importován“ nesmí být PASS.
5. Nejprve původních 52 případů. Pak níže přesně vyjmenovaných 23 párů
   `date_time` absent versus `{type:0}`, každý se stejným syntetickým mapped-car
   profilem, souřadnicemi, `costing:auto`, všemi ignore flags false, shodnými
   exclude polygony, search/snap limitem, jednou variantou a shodnými speed_types.
   Pouze časový režim se liší. Žádný nový pokus při timeoutu nebo odmítnutí.

| Skupina párových případů | Počet párů |
| --- | ---: |
| maxheight/maxwidth/maxlength/maxweight: menší a větší auto pro každý limit | 8 |
| `access=private` a `motor_vehicle=no`, bez deklarované výjimky | 2 |
| jednosměrka: směr vpřed a opačný směr | 2 |
| vyloučená uzávěra: oba směry | 2 |
| aktivní časový zákaz, neaktivní zákaz, omezené časové povolení | 3 |
| conditional destination-only: lokální cíl a tranzitní průjezd | 2 |
| destination-only v kombinaci s překročenou výškou či hmotností | 2 |
| běžná neomezená kontrola a topologie pro diagnostiku multipass | 2 |

Pro každý pár nativně ověřit skutečně použité syntetické way IDs přes
`trace_attributes`, všechny varianty, body do 25 m a průniky uzávěr. Přijatelná
trasa musí projít beze všech ochranných varování a bez zakázané hrany. Varování
401 znamená ochranné odmítnutí, nikoli oprávnění přijmout výsledek. Kontrolní
topologie nemusí reprodukovat 401; pak se zaznamená nereprodukce, ne vynucené
PASS nebo další automatické varianty parametrů.

6. Osm dalších deterministických časových případů pomocí pevného `type:1`:
   čtyři na jednoznačných stranách přechodů CET/CEST a čtyři kolem hranic
   podmíněného zákazu/povolení. Ověřit skutečnou timezone z nativního grafu,
   ne jen řetězec ve vstupu. Nejasná opakovaná/neexistující místní hodina není
   automaticky prokázaná; nevyžadovat privilegované přestavování hodin hostu.
   `type:0` má samostatný smoke podle skutečného aktuálního času. Dva případy
   bez timezone (absent/type0) musí odhalit nezaručené časové vyhodnocení; pokud
   jej nelze rozpoznat a bezpečně ohradit, implicit-now kandidát nemá GO.
7. Pevný rozpočet plné izolované sady: 52 + 46 + 8 + 2 = **108 route** a nejvýše
   **108 trace** volání uvnitř testovacího kontejneru. Dva status a nejvýše
   30 readiness kontrol na každou ze dvou postupných konfigurací: celkem
   nejvýše **278 loopback HTTP volání**, žádný externí provider. Jediný build
   či engine kontejner najednou, `--network none`, žádné veřejné porty,
   1 CPU/768 MiB jako výchozí schvalovaný limit, konečný Root wall deadline.
   Timeout klienta sám nedokazuje konec kontejneru: Root musí ověřit a zastavit
   pouze vlastní přesné CID po kontrole image/job/mount identity. Nikdy daemon,
   prune či cizí kontejner. Rozpočet nezvyšovat automaticky.
8. Až po izolované sadě lze **samostatně** schválit nejvýše tři jednotlivá
   veřejná diagnostická route volání: jeden pár absent/type0 stejné veřejně
   doložené fixture a nanejvýš jednu další kontrolu. Ne tři fixtures krát dva.
   V současném SIM mapped API nelze poslat raw native type0 ani literal `now`;
   pár proto vyžaduje zvlášť Rootem zkontrolovaný existující interní nativní
   adaptér, ne veřejný auth bypass. Musí zachovat schválený graf, polygony,
   profil a stejné options; výstup jen fixture label/status/číselná varování.
   Bez trace/úplné SIM proof kontroly jde pouze o diagnostiku, ne o přijetí
   trasy. Žádná soukromá poloha, raw response, provider text ani retry.
9. Teprve při doloženém přínosu připravit samostatný malý semantic patch a ADR:
   omitted time = now jen pro výslovně vymezený běžný mapped car/single-primary
   aktuální požadavek. Nesahat na diagnostické čtyři JS soubory jako na součást
   jejich nynějšího releasu. Neměnit `speed_types` ani uvádět čerstvé rychlosti,
   pokud nejsou validní. Všechny profily, uzávěry, ignore flags, 401, vzdálenosti
   a auth zůstávají. Ověřit veřejný query/requestHash/geometryHash, graph/closure
   vazby i COP/Jízda verifier; stabilní interní time-policy klíč nesmí vypnout
   coalescing ani využít starý důkaz pro jiný start. Vstupní literal `now` nadále
   nepřijímat. Změnu významu defaultu zdokumentovat, i když se wire input nemění.
10. Samostatný Root candidate/release/rollback a poslední lidsky schválený test
    skutečného iPhonu teprve prokáže řešení uživatelského problému. Neúspěšné
    kontroly nebo již existující `depart_now` znamenají návrat k instrumentaci
    skutečné příčiny, ne uvolnění omezení nebo další nasazení naslepo.

Přesně chybějící příprava dnes: Root-reviewed X5 runner/custody/deadline,
rozšířené syntetické OSM/time fixture plány a ověřené timezone podklady. Základní
52-case harness existuje a serverový nativní obraz je dostupný podle Root/COP;
tyto nové nativní výsledky zatím **nebyly spuštěny ani získány**.

### Repozitářové kontroly

- `pnpm format:check` musí projít nad zdrojovým kódem, package konfigurací a skripty
- `pnpm verify` musí projít před produkčním nasazením nebo musí být výslovně popsán blokující důvod
- generované a archivní artefakty zůstávají mimo Prettier gate přes `.prettierignore`
## Izolované podmíněné restrikce – zdrojový plán, nikoli nativní důkaz

Volitelný přepínač `--routing-time-cases` generátoru
`scripts/generate-mapped-profile-test-pbf.py` doplní vlastní syntetickou mapu
o deset oddělených komponent: soukromý vjezd, jednosměrku, explicitní zákaz,
časově povolený/zakázaný vjezd, destination-only a kombinace s maxheight.
Výchozích osm komponent a původní plán 52 případů zůstávají beze změny.

`scripts/routing-time-engine-plan.mjs` vytvoří **pouze JSON plán** 160 požadavků
(10 komponent × 2 výšky × 2 směry × 4 časové režimy). Žádný požadavek neodesílá.
`none` a nativní `date_time.type=0` jsou oddělené od fixních lokálních časů
12:00/22:00 dne 28.10.2026. Nejde o změnu HTTP kontraktu SIM ani implicitního
času produkční trasy. Nejvýše dalších 160 trace požadavků je pouze návrh
samostatného izolovaného běhu, nikoli rozšíření již schváleného provozního limitu.

Před spuštěním musí Root zvlášť ověřit import conditional tagů a timezone
Europe/Prague; samotný zápis tagu do PBF nic nedokazuje. Plán bez ověřené
materializace není test časových restrikcí. Neobsahuje zatím DST přechody ani
assertion runner a nesupluje dřívější kompletní nativní akceptační plán.
Explicitní/rozměrová omezení jsou povinností v každém časovém režimu.
Destination-only a multipass jsou pozorování, **ne oprávnění přijmout warning401**.
Zákaz `motor_vehicle=no` zde znamená statickou mapovou fixture, nikoli ověření
živého dopravního překryvu nebo schvalování uzávěr.

Lokální test `python3 scripts/test_routing_time_fixtures.py` ověřuje pouze
deterministickou strukturu, zachování původního plánu a zákaz relaxací profilu.
Neprokazuje skutečné nativní routování, legálnost trasy ani opravu incidentu.

## Assisted planning source implementation (29.10.2026)

Aktivní source fragment `planning-origin-v1.openapi.json` a binding OpenAPI mají
dvě nové oddělené operace. Původních 163 cest a jejich původní schémata se
sémanticky nezměnily (porovnání parsed JSON před/po). Nové scope default deny,
žádná změna produkce ani tajemství. Nejde o akceptaci skutečné trasy nebo enginu.

Lokálně na Node24: situation typecheck/build PASS, všech 808 testů PASS,
6 explicitních PostgreSQL opt-in SKIP. Nový soubor planning-origin má 28 testů:
actor/service boundary, 400/401/429/503, bez cache/SF, shodné hashové fixture,
oddělené směry a souřadnice, immutable snapshot/freshness po await, vazby grafu,
výslovný výběr, sanitizace JSON/provider prose, žádná ordinary assessment
promoce. Další actual service tests ověřují normální native payload s profilem,
25m snap/uzávěrami a nezměněné odmítnutí 171/401; fetch je syntetický stub.
Nativní HTTP ani soukromý telefonní dotaz se v této sadě neprovádí.

První spuštění HTTP testů narazilo na omezený lokální listen (EPERM), nikoli
produkční chybu. Stejné testy po schválení lokálního testovacího portu prošly;
žádné bezpečnostní pravidlo aplikace nebylo kvůli tomu vypnuto.

Zbývá: nezávislá source revize COP/SDK, shoda Swift/JS a samostatně schválený
izolovaný native fixture job. Potom samostatný Root image/config rollout
nejprve s default OFF a přesná autorizace provisionování existujícího COP geo
service tokenu; následný řízený pilot umožní společnou iPhone akceptaci skutečné
asistence před obecným uvolněním. Fyzická akceptace tedy není zaměněná za unit
test ani požadovaná před dostupným pilotem. Žádné nové klíče, síťové změny,
TestFlight ani automatické nasazení tento záznam nepovoluje.
