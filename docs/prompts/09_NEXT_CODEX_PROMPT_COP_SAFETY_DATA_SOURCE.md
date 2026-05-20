# Prompt pro COP: integrace Safety Data API

Pokračuj v projektu COP (`/srv/cop`, publikováno jako `https://cop.zeleznalady.cz`) a přidej nový samostatný zdroj veřejných bezpečnostních dat ze SIM.

## Kontext

V projektu SIM byla přidána samostatná služba `safety-data-api`. Služba agreguje veřejná bezpečnostní data pro občanský situační obraz:

- ČHMÚ CAP výstrahy,
- ČHMÚ hydrologické stanice a povodňové stupně,
- řízenou cache, stale-if-error fallback a deduplikaci odpovědí,
- samostatný COP kontrakt `cop-safety-source-v1`.

Autoritativní endpoint pro COP:

```text
https://sim.zeleznalady.cz/safety-data/api/v1/cop/features
```

Metadata a dohled:

```text
https://sim.zeleznalady.cz/safety-data/health/ready
https://sim.zeleznalady.cz/safety-data/metrics
https://sim.zeleznalady.cz/safety-data/api/v1/layers
https://sim.zeleznalady.cz/safety-data/api/v1/sources
https://sim.zeleznalady.cz/safety-data/api/v1/config
```

Lokální kompatibilní projekce přes stávající situation-data existuje také:

```text
https://sim.zeleznalady.cz/situation-data/api/v1/cop/features?layers=warnings,flood&source=safety_data
```

Nová implementace COP má preferovat čistý `safety-data` kontrakt. Projekci přes `situation-data` použij jen tehdy, pokud je rychlejší napojit ji do již existujícího mapového pipeline.

## Úkol v COP

1. Přidej nový datový source typ `PUBLIC_SAFETY_AGGREGATE`.
2. Přidej klienta pro `GET /safety-data/api/v1/cop/features`.
3. Dotazuj podle aktuálního bbox mapy:

```text
GET https://sim.zeleznalady.cz/safety-data/api/v1/cop/features?bbox=west,south,east,north&layers=warnings,flood&limit=250
```

4. Načti registry:
   - `/safety-data/api/v1/layers` pro definici vrstev,
   - `/safety-data/api/v1/sources` pro licenci, atribuci a režim zdrojů,
   - `/safety-data/api/v1/config` pro viditelné runtime nastavení.
5. Přidej v UI ovládání vrstev:
   - `warnings`: oficiální výstrahy,
   - `flood`: hydrologické stanice, hladiny a SPA.
6. Zobraz stav zdroje v dohledovém panelu:
   - OK, degraded podle `warnings`,
   - offline při nedostupnosti endpointu,
   - počet `critical`, `warning`, `advisory`, `stale`.
7. V detailu feature zobraz:
   - `headline`,
   - `category`,
   - `severity`,
   - `urgency`,
   - `certainty`,
   - `observedAt`, `effectiveAt`, `expiresAt`,
   - `confidence`,
   - `stale`,
   - `sourceId`,
   - `license.attribution`,
   - klíčové `metrics`,
   - `affectedAreas` a `geocodes`, pokud existují.

## Kontrakt

Odpověď je GeoJSON `FeatureCollection`:

```json
{
  "contractVersion": "cop-safety-source-v1",
  "type": "FeatureCollection",
  "generatedAt": "2026-05-20T14:25:10.000Z",
  "source": {
    "sourceId": "safety-data-api",
    "sourceType": "PUBLIC_SAFETY_AGGREGATE",
    "generatedAt": "2026-05-20T14:25:10.000Z"
  },
  "summary": {
    "featureCount": 6,
    "sourceCount": 2,
    "staleFeatureCount": 3,
    "advisoryCount": 3,
    "warningCount": 0,
    "criticalCount": 0
  },
  "features": [
    {
      "type": "Feature",
      "id": "warnings:chmi_alerts:example",
      "geometry": {
        "type": "Point",
        "coordinates": [14.4, 50.1]
      },
      "properties": {
        "featureId": "warnings:chmi_alerts:example",
        "layer": "warnings",
        "category": "weather_warning",
        "headline": "Minor Temperature Warning",
        "sourceId": "chmi_alerts",
        "observedAt": "2026-05-20T08:09:04.000Z",
        "effectiveAt": "2026-05-20T08:09:04.000Z",
        "expiresAt": "2026-05-20T20:00:00.000Z",
        "confidence": 0.45,
        "stale": false,
        "severity": "advisory",
        "urgency": "immediate",
        "certainty": "unlikely",
        "license": {
          "name": "CHMI Open Data",
          "attribution": "Czech Hydrometeorological Institute (CHMI)",
          "url": "https://opendata.chmi.cz/"
        },
        "affectedAreas": ["Hlavní město Praha"],
        "geocodes": [{ "scheme": "CISORP", "value": "1100" }],
        "metrics": {
          "areaCount": 14,
          "geocodeCount": 412
        }
      }
    }
  ],
  "sources": [],
  "warnings": []
}
```

## Mapové zobrazení

`warnings`:

- Vykresli jako výstražné anotace nad mapou.
- Barva podle `severity`:
  - `info`: neutrální,
  - `advisory`: žlutá/oranžová,
  - `warning`: oranžová/červená,
  - `critical`: výrazná červená.
- Pokud je `stale=true`, sniž sytost a v detailu jasně označ zastaralost.
- CAP výstrahy mohou mít jen administrativní geokódy bez přesného polygonu. Bod v geometrii ber jako reprezentativní bod, ne jako přesnou hranici výstrahy.

`flood`:

- Vykresli jako body hydrologických stanic.
- Z `metrics` používej hlavně:
  - `waterLevelCm`,
  - `flowM3s`,
  - `floodActivityLevel`,
  - `spa1Cm`, `spa2Cm`, `spa3Cm`, `spa4Cm`.
- Podle `floodActivityLevel` nastav prioritu a vizuální styl:
  - `0`: běžný stav,
  - `1`: bdělost,
  - `2`: pohotovost,
  - `3+`: ohrožení / kritický stav.

## Výkon a cache v COP

- Nedotazuj SIM při každém renderu mapy.
- Použij debounce 2-5 s po změně bboxu.
- Cache v COP drž aspoň 30-120 s podle vrstvy.
- Při stejném bbox/layers/limit reuseuj poslední odpověď.
- Pro velké bboxy používej `limit=250` a v UI nabídni přiblížení mapy pro detail.
- Pokud endpoint vrátí `warnings`, zobraz degraded stav zdroje, ale neshazuj mapu.

## Akceptační kritéria

- COP má nový datový zdroj `SIM Safety Data`.
- COP načte `GET /safety-data/api/v1/layers` a zobrazí vrstvy `warnings` a `flood`.
- COP načte `GET /safety-data/api/v1/cop/features` pro bbox okolo Prahy a vykreslí alespoň jednu výstrahu nebo hydrologickou stanici.
- COP vizuálně odliší `info`, `advisory`, `warning`, `critical`.
- COP ukáže `stale` stav a atribuci licence v detailu.
- Výpadek `safety-data` endpointu neovlivní SIM syntetické tracky, flight-data ani situation-data.
- Konzole prohlížeče je bez neobsloužených runtime chyb.

## Důležité hranice

Safety Data nejsou COP tracky a nesmí se ukládat do historie pohybu cílů. Jde o mapové bezpečnostní vrstvy pro občanský situační obraz.

Data z ČHMÚ jsou veřejný kontext. COP nesmí v UI tvrdit, že nahrazují oficiální krizové nebo výstražné kanály.
