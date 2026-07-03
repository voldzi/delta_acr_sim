# COP Sensor Node Contract

**Status:** neveřejný server-to-server ingest pro autorizované edge senzory. COP ani browser klient tento endpoint nevolá přímo.

COP Sensor Node je pasivní edge uzel pro vlastní nebo partnerské senzory, typicky:

- ADS-B / Mode-S přijímač,
- Remote ID přijímač,
- lokální meteosenzor,
- stavová telemetrie uzlu.

SIM dávku přijme, validuje a převádí letové observace do existující vrstvy `partner_air_tracks`. COP proto dál používá standardní `GET /flight-data/api/v1/cop/tracks`; žádný nový mapový provider kvůli sensor node není potřeba.

## Ingest

```http
POST /flight-data/api/v1/ingest/sensor-observations
Authorization: Bearer <FLIGHT_DATA_SENSOR_NODE_INGEST_TOKEN>
Content-Type: application/json
```

Pokud `FLIGHT_DATA_SENSOR_NODE_INGEST_TOKEN` není nastaven, SIM použije jako kompatibilní fallback `FLIGHT_DATA_PARTNER_INGEST_TOKEN`. Pokud není nastaven ani jeden token, endpoint vrací `503 SOURCE_UNAVAILABLE`.

Minimální dávka:

```json
{
  "schema": "cop.sensor.batch.v1",
  "sensor_id": "sensor-node-prg-001",
  "sent_at_utc": "2026-07-03T12:00:00.000Z",
  "sensor": {
    "lat": 50.087,
    "lon": 14.421,
    "height_m": 285
  },
  "observations": [
    {
      "schema": "cop.sensor.observation.v1",
      "type": "adsb",
      "observed_at_utc": "2026-07-03T11:59:58.000Z",
      "payload": {
        "icao24": "49d63f",
        "callsign": "OKVCL",
        "lat": 49.966053,
        "lon": 14.247783,
        "altitude_ft": 24550,
        "ground_speed_kt": 310.6,
        "track_deg": 99.83,
        "vertical_rate_fpm": 1216,
        "squawk": "3323",
        "category": "A1",
        "nic": 9,
        "nac_p": 10,
        "nac_v": 2,
        "sil": 3,
        "sda": 2,
        "rc": 75,
        "radio": {
          "protocol": "adsb",
          "rssi_dbfs": -8.7,
          "message_count": 34
        }
      }
    },
    {
      "schema": "cop.sensor.observation.v1",
      "type": "remote_id",
      "observed_at_utc": "2026-07-03T11:59:59.000Z",
      "payload": {
        "uas_id_hash": "sha256:9d5a0f6a203a26d06d",
        "lat": 50.0892,
        "lon": 14.4231,
        "height_m": 88,
        "speed_mps": 9.4,
        "track_deg": 71,
        "radio": {
          "protocol": "opendroneid",
          "rssi_dbm": -61,
          "channel": 6
        }
      }
    }
  ]
}
```

Odpověď:

```json
{
  "contractVersion": "sim-cop-sensor-node-ingest-v1",
  "sourceId": "partner_air_tracks",
  "accepted": 2,
  "rejected": 0,
  "trackAccepted": 2,
  "trackRejected": 0,
  "weatherAccepted": 0,
  "healthAccepted": 0,
  "warnings": [],
  "storedTrackCount": 2,
  "sensorStats": {
    "stored": 1,
    "oldestAgeSeconds": 0,
    "newestAgeSeconds": 0
  }
}
```

## Diagnostika

```http
GET /flight-data/api/v1/ingest/sensor-observations/status
GET /flight-data/api/v1/ingest/sensor-nodes
```

`/sensor-nodes` je chráněný stejným bearer tokenem jako ingest. Vrací poslední známý stav uzlů, počty observací, poslední weather/health telemetrii a poslední polohu samotného sensor node. Nepoužívej ho jako veřejnou mapovou vrstvu.

## Výstup pro COP

COP čte standardně:

```http
GET /flight-data/api/v1/cop/tracks?source=partner_air_tracks,adsb_lol&bbox=west,south,east,north
```

Letové stopy ze Sensor Node se v `tracks[]` projeví stejně jako ostatní flight data:

- ADS-B observace mají `trackKeyKind=icao24`, `metadata.sourceKind=sensor_node` a `quality.measurement.sourceProtocols=["adsb"]`.
- Remote ID observace mají `trackKeyKind=remote_id`, `objectType=UAV`, `aircraft.iconHint=uav`, `metadata.sourceKind=remote_id`.
- `quality.measurement` obsahuje strukturované údaje pro COP predikci: `predictionSupport`, `horizontalAccuracyM`, `rcM`, `nacP`, `nacV`, `nic`, `sil`, `sda`, RSSI, počet zpráv a identifikaci přijímače.

Remote ID soukromí:

- SIM preferuje `uas_id_hash`.
- Pokud edge uzel pošle jen surové `uas_id`, SIM ho před uložením zahashuje na `sha256:<prefix>`.
- Operátorská/pilotní poloha se nepropaguje do běžného COP výstupu.
- COP má běžným operátorům zobrazovat hashovanou UAS identitu, ne surové osobní nebo registrační údaje.

## TAK rozhraní

TAK inbound již zajišťuje TAK Gateway:

```http
POST /tak-gateway/api/v1/cot/events
Authorization: Bearer <TAK_GATEWAY_INGEST_TOKEN>
Content-Type: application/xml
```

SIM outbound pro budoucí vlastní TAK server:

```http
GET /flight-data/api/v1/cot/tracks?bbox=west,south,east,north&source=partner_air_tracks,adsb_lol
Authorization: Bearer <FLIGHT_DATA_TAK_COT_EXPORT_TOKEN>
Accept: application/xml
```

Výstup je CoT XML s `a-u-A` pro obecné vzdušné stopy a `a-u-A-M-F-Q` pro UAV. Jde o situační publikaci normalizovaných stop, ne o naváděcí nebo bojový workflow. `remarks` obsahuje zdroj, confidence a predikční podporu, aby bylo možné auditovat původ stopy.

## Konfigurace

```bash
FLIGHT_DATA_ENABLED_SOURCES=adsb_lol,partner_air_tracks
FLIGHT_DATA_PARTNER_INGEST_TOKEN=<high-entropy-partner-token>
FLIGHT_DATA_SENSOR_NODE_INGEST_TOKEN=<high-entropy-sensor-token>
FLIGHT_DATA_SENSOR_NODE_STATUS_TTL_SECONDS=900
FLIGHT_DATA_SENSOR_NODE_MAX_NODES=1000
FLIGHT_DATA_TAK_COT_EXPORT_TOKEN=<high-entropy-cot-export-token>
FLIGHT_DATA_TAK_COT_EXPORT_STALE_SECONDS=180
```

Veřejné open-data flight zdroje:

- `adsb_lol` je produkční open-data pilot a vrací bohatý readsb payload včetně kvality měření.
- `local_adsb` připojuje vlastní nebo partnerské readsb/dump1090 přijímače.
- `opensky` je podporovaný pouze s doloženým oprávněním.
- Veřejný autoritativní live Remote ID feed pro ČR není v SIM nakonfigurován; Remote ID se řeší autorizovaným Sensor Node nebo partner ingestem.
