# ARDOS Partner Data Contract

## Účel

Tento dokument je podklad pro jednání s ARDOS partner network. ARDOS není veřejný open-data zdroj; integrace má být partnerská, zabezpečená a datově minimalizovaná. SIM bude působit jako adapter/cache mezi ARDOS a COM.

Pro nové provedení používej terminologii COM a source-neutral provider model; historické názvy `cop` v ukázkách znamenají pouze kompatibilní backend stream.

## Co od ARDOS potřebujeme

Minimální požadavek je endpoint, který vrací už filtrovanou GeoJSON projekci pro aktuální mapový výřez:

```http
GET /api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=ground,traffic,mobile&limit=250
Authorization: Bearer <partner-token>
Accept: application/json
```

Odpověď:

```json
{
  "contractVersion": "ardos-cop-source-v1",
  "generatedAt": "2026-05-20T10:15:00.000Z",
  "features": [
    {
      "type": "Feature",
      "id": "team:regional-relay-01",
      "geometry": { "type": "Point", "coordinates": [14.42, 50.08] },
      "properties": {
        "featureId": "team:regional-relay-01",
        "layer": "mobile",
        "category": "emcomm_relay",
        "label": "ARDOS relay team",
        "observedAt": "2026-05-20T10:14:30.000Z",
        "validUntil": "2026-05-20T10:17:30.000Z",
        "confidence": 0.82,
        "severity": "info",
        "metrics": {
          "positionAccuracyM": 75,
          "batteryPercent": 68
        },
        "tags": {
          "status": "available",
          "capability": "voice,data"
        }
      }
    }
  ],
  "warnings": []
}
```

## Povolené vrstvy a kategorie

| Layer | Kategorie | Poznámka |
| --- | --- | --- |
| `mobile` | `emcomm_relay`, `field_team`, `mobile_gateway`, `drone_operator` | Pohyblivé týmy a komunikační body bez osobních jmen. |
| `traffic` | `uas_operation`, `drone_observation`, `patrol_route` | Dronové operace, video/pozorování a trasy jako kontext, ne jako cíle ke sledování osob. |
| `ground` | `command_post`, `temporary_repeater`, `shelter_support`, `field_report` | Pevné body a hlášení pro krizový obraz. |

## Datová minimalizace

Ve veřejném nebo občanském COM se nesmí posílat:

- jména, telefonní čísla, volací znaky jednotlivců, registrační značky soukromých vozidel,
- přesný živý pohyb dobrovolníků, pokud není pro daný účel schválen,
- interní taktické poznámky, neveřejné radiové frekvence, přístupové údaje, odkazy na interní video streamy bez autorizace.

Preferovaný model je pseudonymní identifikátor týmu nebo role a časově omezená poloha se zaokrouhlením podle citlivosti.

## Bezpečnost

- Produkce musí používat HTTPS.
- První fáze může použít statický bearer token v `ARDOS_PARTNER_TOKEN`.
- Další fáze má přejít na rotované tokeny nebo mTLS.
- ARDOS endpoint musí umět omezit data podle oprávnění klienta.
- SIM cacheuje odpovědi krátce (`SITUATION_DATA_ARDOS_CACHE_TTL_SECONDS`, default 15 s) a při výpadku použije stale-if-error.

## Konfigurace v SIM

```bash
SITUATION_DATA_ENABLED_SOURCES=open_meteo,aviation_weather,ctu_nettest,ctu_stationary_mobile,pid_gtfs_rt,safety_data,ardos_partner
ARDOS_PARTNER_BASE_URL=https://ardos-partner.example.cz
ARDOS_PARTNER_TOKEN=...
SITUATION_DATA_ARDOS_CACHE_TTL_SECONDS=15
```

## Implementační stav v SIM

SIM už obsahuje zdroj `ardos_partner`:

- endpoint ARDOS volá jen při explicitním zapnutí zdroje,
- bez URL/tokenu vrací varování a žádná data,
- výstup mapuje do standardního `cop-situation-source-v1`,
- `sourceId` normalizuje na `ardos_partner`,
- zachovává `metrics`, `tags`, `severity`, `observedAt` a `validUntil`.

## Návrh prvního společného testu

1. ARDOS vystaví neveřejný staging endpoint s 5-20 syntetickými/pseudonymními features pro oblast Prahy.
2. SIM nastaví `ARDOS_PARTNER_BASE_URL` a token jen na pilotním `docker.home.cz`.
3. COM přidá vrstvu "ARDOS partner" dostupnou jen v interním režimu.
4. Ověříme latenci, cache, stale chování, varování a to, že veřejné zobrazení neukazuje citlivá data.
