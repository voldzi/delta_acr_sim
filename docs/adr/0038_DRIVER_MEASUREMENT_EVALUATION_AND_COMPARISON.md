# ADR 0038 Evaluace dobrovolných měření Jízdy

Stav: přijato pro přípravu zdrojového kódu. Produkční aktivace je pozastavena.
Datum: 13. 10. 2026.
Navazuje na [ADR 0030](0030_CONSENTED_DRIVER_MEASUREMENTS.md).

## Účel a rozsah

Dobrovolné měření má být dostupné každému autentizovanému účtu přes COP,
nikoli pouze seznamu pilotních účtů. Dostupná funkce neznamená udělený souhlas:
COP nadále ověřuje identitu, dobrovolný souhlas a jeho odvolání a odvozuje
denní pseudonym. SIM přijímá jen vyhrazenou autentizovanou službu COP.
Token, HMAC tajemství a přímý přístup do SIM ani Valhally nepatří do telefonu.

Rozšíření poskytuje výsledky k hodnocení dosavadního sběru. Kontrakt
`sim-driver-measurements-v1` zůstává `shadow_only`; neaktivuje přepis
oficiálních rychlostí, Valhalla `traffic.tar` ani výpočtu ETA.

## Rozhodnutí

Přidáváme interní čtecí endpoint
`/api/v1/internal/driver-measurements/v1/evaluation`. Vyžaduje stejné
službové přihlášení jako `/quality`, odmítá browser `Origin` a neznámé query
parametry. Při vypnutém příjmu vrací 503 i v režimu samotné revokace.
Dosavadní dávky, receipts, agregáty a jejich verze se nemění.

Evaluace používá jednu databázovou transakci `READ ONLY REPEATABLE READ`.
Z retained receipts poskytuje počty dávek, přijatých a duplicitních intervalů,
poslední příjem a osm povolených důvodů odmítnutí za dobu retence sedm dnů.
Samostatně uvádí aktivní tombstones revokací. Počty rychlostních skupin a
hodinové souhrny klientsky hlášené ETA zahrnují uložené bucket starts za
posledních 24 hodin. Nejsou to počty všech neúspěšných HTTP požadavků.

Publikovaný `sim-driver-evaluation-v1` obsahuje pouze typované skalární
souhrny. Neobsahuje GPS, UUID požadavků, pseudonymy, contributor hashes,
identifikátory hran, jednotlivé jízdy ani volný text. Zobrazuje se pouze
v chráněném operátorském přehledu SIM; není veřejnou mapovou vrstvou ani
kontextem pro AI. Prázdné ETA je prázdné pole, poslední příjem bez dat je
`null`; nejsou nahrazovány tvrzením o nulové chybě nebo úplném pokrytí.

Počty aktuálních, historických a budoucích skupin se vztahují k aktivnímu
grafu; skupiny jiného grafu jsou oddělené. Kvalitativní práh znamená alespoň
pět atestovaných přispěvatelů a deset intervalů, nikoli nezávislé osoby,
úplné pokrytí hrany nebo ověřenou navigační přesnost. `closedWindowGroupCount`
znamená ukončené pětiminutové okno, nikoli celou projetou hranu.
`futureGroupCount` označuje budoucí bucket; v1 neuchovává přesný čas každého
pozorování a nerozliší budoucí bod ve stejném bucketu. Aktuální okno končí
na `floor(asOf / 5 min) × 5 min + 5 min`; upload ani evaluace jej neprodlužují.

Časy `generatedAt`, `asOf` a konec hodnoticího intervalu jsou shodné.
Čerstvý report nevytváří nové `observedAt` ani nedokazuje čerstvé rychlosti.
ETA zůstává `client_reported_not_ground_truth`; procentní odchylka používá
původní předpovězenou dobu jako jmenovatel. Příspěvky mají stejnou váhu
po mediánu na přispěvatele, bez zvýhodnění častějšího vzorkování.

## Porovnávání a budoucí živé použití

Samostatný čistý selector má výchozí režim `disabled` a umí pouze
`comparison_only`. Posuzuje aktivní graf, explicitně směrově revidované
hrany, původní konec okna, minimální počty, rychlostní strop a omezený
rozptyl. Čerstvý oficiální zdroj má přednost; neznámé oficiální pokrytí
není důkaz jeho absence. Selector nic nestahuje, neukládá a nevolá writer.
Runtime report této etapy uvádí `comparisonMode:"disabled"`,
`livePromotionSupported:false` a `liveAppliedGroupCount:0`.

Živé využití vyžaduje další samostatný kontrakt a akceptaci:

- účelový souhlas pro živé doplňování rychlostí, bez zpětného rozšíření
  významu dosavadního `traffic-quality-v1`;
- dostatečný průjezd směrovou hranou, skutečné stáří pozorování, zachycení
  čekání v dopravě a kontrolu paralelních komunikací;
- ověření nezávislosti přispěvatelů, odolnosti vůči spoofingu a souběžné
  kapacity bez oslabování ochranných limitů;
- autoritativní důkaz oficiálního pokrytí a přednosti čerstvého oficiálního
  zdroje, nikoli inference z prázdného nebo zkráceného seznamu;
- transakční generační ochranu revokací a potvrzení vyčištění všech
  odvozených live kopií před dokončením smazání;
- nezávislé vyhodnocení skutečné ETA a omezený canary s automatickým návratem.

Pětiminutová platnost ani čerstvost reportu nejsou generační ochrana revokace.
Starší repeatable-read pohled může doběhnout po souběžném DELETE. Nové čtení
již smazaný příspěvek nevidí; tuto vlastnost nelze přenést na uložený
live overlay. Pole `revocationCoverage:"database_only"` tuto hranici zachovává.

## Mazání a provozní aktivace

DELETE zůstává dostupný při vypnutém sběru se zachovaným režimem revokace.
Pokud je nakonfigurovaný odvozený operátorský report, úspěch 200 vyžaduje
jeho novou evaluaci nebo odstranění. Selhání potvrzení vrátí 503, ačkoli
databázové DELETE již mohlo dokončit; COP ponechá frontu mazání a retry.
COP 202 nadále znamená čekající smazání, ne dokončené smazání.
Tato ochrana jednoho operátorského reportu není ochrana budoucího live writeru
ani důkaz odstranění z fyzických záloh.

Zdrojová příprava nezakládá produkční okno. Dokud platí infrastrukturní HOLD,
neprobíhá build, změna obrazů, flags, secrets, sítě, databáze ani restart.
Nasazení vyžaduje koordinované okno, kontrolu přesné revize a obrazů,
ověření chráněných API a reportu a společnou akceptaci COP a Jízdy.
Návrat vypíná sběr a publikaci, nikoli mazání a retenční úklid; databáze
se neobnovuje do staršího stavu. Postup je v [runbooku 17](../runbooks/17_DRIVER_MEASUREMENTS_PRODUCTION.md).
