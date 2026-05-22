# Analýza zdrojů leteckých dat

## Cíl

Služba má pro COM poskytnout jednotný zdroj reálných nebo testovacích leteckých tracků:

- aktuální polohy letadel,
- deduplikaci podle `icao24`,
- doplnění základních metadat letadel,
- referenční databázi letišť,
- referenční databázi typů letadel,
- transparentní informaci o původu dat a licenci.

Výchozí implementace proto odděluje normalizovaný provider kontrakt od konkrétního poskytovatele. COM se integruje na `flight-data-api`; zdroje se mění konfigurací služby.

## Doporučené zdroje

| Zdroj | Použití v pilotu | Pozdější komerce | Poznámka |
| --- | --- | --- | --- |
| OurAirports | Ano, letiště | Ano | Data jsou public domain, vhodné jako základ letištní reference. Zdroj uvádí noční CSV exporty a public domain podmínky. |
| Vlastní ADS-B přijímač / readsb `aircraft.json` | Ano, pokud máme přijímač | Ano, při vlastním provozu nebo partnerské dohodě | Nejčistší cesta k lokálnímu pokrytí ČR a nízkých letů. Nepřeposílat cizí feedy bez oprávnění. |
| ADSB.lol | Ano, live ADS-B testy | Ano, s ODbL povinnostmi | API je veřejné a data jsou ODbL. Pro produkční provoz je vhodné kontaktovat provozovatele, aby se nerozbilo SLA nebo API klíče. |
| OpenSky Network | Pouze výzkum/test se souhlasem | Jen písemná licence | Podmínky omezují použití na neprofitní výzkum/vzdělávání; komerční i operační REST API použití vyžaduje písemnou licenci. |
| ICAO API Data Service | Test přes trial | Ano, přes oficiální API/licenci | Vhodný cílový zdroj pro oficiální typy letadel a ICAO kódy. Trial poskytuje omezený počet volání. |
| OpenFlights | Jen doplňkově | Rizikové bez posouzení | ODbL plus historická/neudržovaná route data. Lze použít pro demo lookup, ne jako autoritativní provozní základ. |
| OpenSky Aircraft Database | Jen doplňkově | Rizikové | Samotná aircraft DB je deklarovaná jako nelicencovaná/as-is crowdsourced databáze. Pro komerční produkt je lepší licencovaný zdroj. |

## Licenční závěr

Pro pilotní nekomerční testování:

1. Výchozí režim `mock` je bezpečný a zcela syntetický.
2. `adsb_lol` lze zapnout pro realistický live provoz, pokud aplikace zobrazí atribuci a zachová ODbL povinnosti.
3. `local_adsb` je preferovaný další krok pro vlastní přijímače v ČR.
4. `opensky` držíme jako volitelný adapter, ale v konfiguraci defaultně vypnutý.

Pro komerční použití:

1. Letiště: primárně OurAirports, protože public domain je nejčistší model.
2. Live lety: vlastní/partnerská ADS-B síť, ADSB.lol při splnění ODbL a provozních podmínek, nebo placený/licencovaný provider.
3. Typy letadel: primárně oficiální ICAO API Data Service nebo smluvně čistý datový balík.
4. COM kontrakt nesmí záviset na jednom providerovi; musí dostávat normalizované pole `sources` a `sourceLicenses`.

## Zdrojové odkazy

- OurAirports data: https://ourairports.com/data/
- readsb: https://github.com/wiedehopf/readsb
- ADSB.lol API: https://www.adsb.lol/docs/open-data/api/
- ADSB.lol license: https://www.adsb.lol/privacy-license/
- ODbL summary: https://opendatacommons.org/licenses/odbl/summary/
- OpenSky terms: https://opensky-network.org/about/terms-of-use
- OpenSky REST API: https://openskynetwork.github.io/opensky-api/rest.html
- OpenSky aircraft database: https://opensky-network.org/data/aircraft
- ICAO API Data Service: https://dataservices.icao.int/
- OpenFlights data/license: https://openflights.org/data.php
