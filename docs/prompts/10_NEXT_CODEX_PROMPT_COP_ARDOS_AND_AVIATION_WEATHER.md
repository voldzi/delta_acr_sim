# Prompt pro COP: ARDOS partner, aviation weather a lokální ADS-B metadata

Pokračuj v projektu COP a připrav aplikaci na nové zdroje poskytované SIM.

## Kontext

SIM nově poskytuje:

- `flight-data` source `local_adsb` pro vlastní readsb/dump1090 přijímače. Kontrakt pro COP zůstává `cop-flight-source-v1`.
- `flight-data` referenční letiště přes cacheovaný OurAirports import.
- `situation-data` source `aviation_weather` pro NOAA AWC METAR/TAF letištní počasí.
- `situation-data` source `ardos_partner` pro neveřejná partnerská data ARDOS. Zdroj bude dostupný jen po dohodě a tokenu.

Veřejné SIM endpointy:

```text
https://sim.zeleznalady.cz/flight-data/api/v1/cop/tracks
https://sim.zeleznalady.cz/situation-data/api/v1/cop/features
https://sim.zeleznalady.cz/flight-data/api/v1/airports
https://sim.zeleznalady.cz/flight-data/api/v1/sources
https://sim.zeleznalady.cz/situation-data/api/v1/sources
```

## Úkoly v COP

1. Rozšiř source registry o `aviation_weather` a `ardos_partner`.
2. `aviation_weather` zobraz jako letištní počasí ve vrstvě weather:
   - ikona letiště nebo METAR stanice,
   - badge `VFR/MVFR/IFR/LIFR`,
   - detail: teplota, vítr, tlak, raw METAR/TAF jen v debug/detail panelu.
3. `ardos_partner` zobraz jen pro autorizované/interní pohledy:
   - vrstvy `ground`, `mobile`, `traffic`,
   - respektuj `severity`, `confidence`, `stale`, `validUntil`,
   - nezobrazuj osobní identifikátory ani citlivé raw payloady ve veřejném režimu.
4. Flight data:
   - nic neměň na kontraktu tracků,
   - zobraz ve zdrojových metadatech, zda track přišel z `local_adsb`, `adsb_lol` nebo jiné kombinace,
   - historii/predikci drž dál v COP nad `trackId` a `lastSeenAt`.
5. Přidej health/dependencies diagnostiku:
   - `flight-data` warnings,
   - `situation-data` warnings,
   - degraded stav pro `ardos_partner` bez tokenu nebo se stale features.

## Akceptační kritéria

- COP umí zobrazit `source=aviation_weather&layers=weather` bez míchání letištního počasí mezi pohybující se tracky.
- COP ignoruje `ardos_partner`, pokud uživatel nemá interní oprávnění.
- COP nevolá NOAA AWC, ARDOS ani veřejné ADS-B providery přímo. Volá pouze SIM.
- Cache zůstává na straně SIM; COP smí používat vlastní krátkou UI cache, ale nesmí násobit upstream dotazy.

## Odkazy v SIM dokumentaci

- `docs/integration/08_FLIGHT_DATA_SOURCE_CONTRACT.md`
- `docs/integration/09_SITUATION_DATA_SOURCE_CONTRACT.md`
- `docs/integration/11_ARDOS_PARTNER_DATA_CONTRACT.md`
- `docs/integration/12_COP_DISPLAY_GUIDE_FOR_NEW_DATA.md`
