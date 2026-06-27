# Radio Planning Model

## Purpose

SIM poskytuje ad-hoc radiove planovani nad DEM/line-of-sight modelem pro COP.
Nejde o trvalou mapovou vrstvu. COP vola tyto endpointy az po akci operatora:

- operator chce z bodu videt odhad pokryti,
- operator overuje spojeni mezi dvema body,
- operator hleda vhodne stanoviste v oblasti.

Vystupy jsou modelove odhady. Nezahrnuji budovy, vegetaci, ruseni, vytizeni
pasma/site, sitove topologie, sifrovani, COMSEC, realne operatorovy RF planovani
ani klasifikovane parametry.

## API

Katalog vestavenych a vlastnich profilu:

```http
GET /situation-data/api/v1/radio/profiles
```

Ulozeni vlastniho profilu:

```http
POST /situation-data/api/v1/radio/profiles
```

Overeni bod-bod:

```http
POST /situation-data/api/v1/radio/link-check
```

Pokryti z bodu:

```http
POST /situation-data/api/v1/radio/coverage
```

Hledani stanoviste:

```http
POST /situation-data/api/v1/radio/site-search
```

## Built-In Profiles

Vestaveny katalog pokryva bezne civilni, radioamaterske, profesionalni,
verejno-bezpecnostni, IoT/data-link a obecne vojenske sablony pouzitelne v CR.
Vojenske profily jsou pouze neklasifikovane genericke sablony.

Vybrane skupiny:

- PMR446: `pmr446_handheld`, `pmr446_elevated`,
- CB: `cb_27_handheld`, `cb_27_vehicle`, `cb_27_base`,
- HAM: `ham_50_*`, `ham_70_mobile`, `ham_145_*`, `ham_433_*`, `ham_1296_ptp`,
- professional VHF/UHF: `business_vhf_*`, `business_uhf_*`,
- TETRA generic: `tetra_handheld`, `tetra_vehicle`, `tetra_repeater`,
- marine/aviation generic: `marine_vhf_*`, `aviation_vhf_ground`,
- IoT/data: `lora_433_sensor`, `lora_868_sensor`, `wifi_24_ptp`, `wifi_5_ptp`, `wifi_6_ptp`,
- generic military: `mil_vhf_manpack`, `mil_vhf_vehicle`, `mil_vhf_relay`, `mil_uhf_handheld`, `mil_uhf_vehicle`, `mil_lband_short_range`.

Katalog vraci u kazdeho profilu:

```json
{
  "profileId": "pmr446_handheld",
  "name": "PMR446 handheld",
  "category": "civil",
  "source": "builtin",
  "frequencyMhz": 446,
  "txPowerW": 0.5,
  "antennaHeightM": 1.5,
  "receiverHeightM": 1.5,
  "antennaGainDbi": 0,
  "receiverAntennaGainDbi": 0,
  "systemLossDb": 2,
  "receiverSensitivityDbm": -116,
  "requiredFresnelClearancePct": 60,
  "maxRadiusM": 5000,
  "defaultAzimuthStepDeg": 10,
  "defaultDistanceStepM": 250,
  "modelApplicability": "terrain_los",
  "sensitiveUse": false,
  "notes": []
}
```

## Custom Profile

COP muze nechat operatora zvolit vestaveny profil, nebo zadat vlastni radio a
ulozit jej pro dalsi pouziti:

```json
{
  "profileId": "custom_team_radio",
  "name": "Tymove radio",
  "category": "business",
  "frequencyMhz": 170,
  "txPowerW": 10,
  "antennaHeightM": 4,
  "receiverHeightM": 1.5,
  "antennaGainDbi": 2,
  "receiverAntennaGainDbi": 0,
  "systemLossDb": 2,
  "receiverSensitivityDbm": -118,
  "requiredFresnelClearancePct": 60,
  "maxRadiusM": 12000
}
```

SIM uklada vlastni profily do datoveho adresare `situation-data` jako
`radio-profiles.json`. COP do profilu nesmi posilat klasifikovane frekvence,
COMSEC material, callsigny ani takticky citlive poznamky.

## Link Check

Request:

```json
{
  "profileId": "pmr446_handheld",
  "radioName": "PMR tym A",
  "from": { "lon": 14.42, "lat": 50.08, "antennaHeightM": 1.5 },
  "to": { "lon": 14.425, "lat": 50.085, "receiverHeightM": 1.5 }
}
```

Response obsahuje:

- `result.linkStatus`: `clear`, `marginal`, `obstructed`, `unknown`,
- `result.quality`: `good`, `fair`, `weak`, `none`, `unknown`,
- `result.distanceM`, `azimuthDeg`, `reverseAzimuthDeg`,
- `result.estimatedRxPowerDbm`, `linkMarginDb`, `freeSpacePathLossDb`,
- pri dostupnem DEM take `lineOfSightClear`, `maxObstructionM`,
  `minFresnelClearanceM`, `requiredExtraAntennaHeightM`,
- `profileSamples[]` pro vykresleni vyskoveho profilu v COP.

## Coverage

Request:

```json
{
  "profileId": "ham_145_handheld",
  "radioName": "VHF stanoviste",
  "station": { "lon": 14.42, "lat": 50.08, "antennaHeightM": 1.5 },
  "radiusM": 15000,
  "azimuthStepDeg": 5,
  "distanceStepM": 250
}
```

Response je GeoJSON `FeatureCollection` s `contractVersion=sim-radio-coverage-v1`.
`features[]` jsou sektorove polygony. COP je vykresli jako docasnou analyzu:

- barva podle `properties.quality`,
- detail podle `estimatedRxPowerDbm`, `linkMarginDb`, `lineOfSightClear`,
  `terrainPenaltyDb`, `maxObstructionM`,
- v detailu vzdy zobrazit `profile`, `summary.disclaimer` a `warnings[]`.

## Site Search

Request:

```json
{
  "profileId": "mil_vhf_manpack",
  "radioName": "Generic VHF team",
  "searchArea": { "bbox": [14.1, 49.9, 14.6, 50.2] },
  "targets": [
    { "lon": 14.42, "lat": 50.08, "receiverHeightM": 1.5 }
  ],
  "stationAntennaHeightM": 2,
  "gridStepM": 250,
  "maxCandidates": 20
}
```

Response je GeoJSON `FeatureCollection` s `contractVersion=sim-radio-site-search-v1`.
`features[]` jsou bodovi kandidati se serazenim:

- `rank`,
- `score`,
- `recommended`,
- `visibleTargetCount`,
- `targetCount`,
- `coveredTargetPct`,
- `meanLinkMarginDb`,
- `minFresnelClearanceM`,
- `worstLinkStatus`.

## COP Presentation

COP ma vytvorit nastroj `Radio LoS` se tremi rezimy:

- `Pokryti z bodu` -> `POST /radio/coverage`,
- `Spojeni bod-bod` -> `POST /radio/link-check`,
- `Najit nejlepsi stanoviste` -> `POST /radio/site-search`.

Operator nejprve vybere radio profil z `GET /radio/profiles`, nebo vytvori
vlastni profil pres `POST /radio/profiles`.

COP musi u kazdeho vysledku zobrazit upozorneni:

```text
Vysledek je modelovy odhad podle DEM a zadanych parametru radia. Nezahrnuje
budovy, vegetaci, ruseni, realne vytizeni site/pasma ani klasifikovane nebo
operatorovy RF parametry.
```

## Operations

Kontrolni priklady:

```bash
curl -fsS http://localhost:5020/situation-data/api/v1/radio/profiles
curl -fsS -X POST http://localhost:5020/situation-data/api/v1/radio/link-check \
  -H 'content-type: application/json' \
  -d '{"profileId":"pmr446_handheld","from":{"lon":14.42,"lat":50.08},"to":{"lon":14.425,"lat":50.085}}'
```
