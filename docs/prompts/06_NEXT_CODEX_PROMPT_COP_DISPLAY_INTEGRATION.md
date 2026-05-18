# Next CODEX prompt: COP display of SIM live tracks

Pracuj v sousedním projektu COP. Nepracuj v SIM repozitáři, pokud k tomu nenajdeš konkrétní důvod. Cílem je opravit nebo ověřit zobrazení syntetických objektů, které do COP publikuje SIM.

## Situace

Na `docker.home.cz` běží dva oddělené projekty:

- SIM je nasazený v `/srv/sim`.
- SIM UI běží na `http://docker.home.cz:5020`.
- SIM API běží interně v kontejneru na portu `4000`.
- SIM publisher je přepnutý do `LIVE` režimu.
- COP je nasazený v `/srv/cop`.
- COP API běží na `http://docker.home.cz:4310`.
- COP web běží na `http://docker.home.cz:4311`.

SIM má v `/srv/sim/.env` nastavené:

```env
SIM_WEB_PORT=5020
API_PORT=4000
SIM_PUBLISHER_MODE=LIVE
SIM_SOURCE_SYSTEM_ID=sim-air-situation-001
SIM_ADAPTER_VERSION=0.1.0
SIM_DATA_DIR=/data
MAIN_COP_BASE_URL=http://172.17.0.1:4310
EXTERNAL_AI_ALLOWED=false
```

COP má v `/srv/cop/.env` mimo jiné:

```env
COP_API_PORT=4310
COP_WEB_PORT=4311
COP_API_BASE_URL=http://localhost:4310
COP_PUBLIC_API_BASE_URL=http://docker.home.cz:4310
COP_ALLOW_LAB_TOKEN=true
COP_LAB_TOKEN=dev-lab-token
COP_EXTERNAL_AI_ENABLED=false
COP_AI_DEFAULT_PROVIDER=mock
COP_DEPLOY_DOMAIN=docker.home.cz
```

COP API přijímá laboratorní autorizaci:

```http
Authorization: Bearer dev-lab-token
```

V registru zdrojů COP je aktivní zdroj `sim-air-situation-001`, který přijímá syntetické eventy pro `AIRCRAFT`, `UAV` a `MISSILE_TRACK`.

## Ověřený stav

SIM už byl otestován v `LIVE` režimu proti COP API. Testovací scénář vytvořil a odeslal 5 syntetických objektů:

- 2x aircraft
- 2x UAV
- 1x missile track

SIM publisher queue měla odeslané položky ve stavu `SENT`.

COP API data vrací. Na serveru má fungovat ověření:

```bash
curl -fsS \
  -H "Authorization: Bearer dev-lab-token" \
  "http://localhost:4310/api/v1/cop/tracks?includeSynthetic=true"
```

Při poslední kontrole COP API vracelo 5 objektů, například:

- `AIR_SIM_AIRCRAFT-0001`
- `AIR_SIM_AIRCRAFT-0002`
- `AIR_SIM_UAV-0001`

Všechny objekty jsou syntetické (`synthetic: true`) a mají zdroj `sim-air-situation-001`.

## Problém

COP API objekty má, ale COP web na `http://docker.home.cz:4311` při kontrole ukazoval:

- `Sources 0`
- `Objects 0`
- prázdný stav "Zatím nejsou přijata žádná COP data..."

Tedy problém pravděpodobně není v SIM publish/ingest cestě, ale v COP webu nebo v jeho komunikaci s COP API.

Podezřelé místo v COP webu:

- `apps/cop-web/src/main.tsx`
- Web podle dosavadní kontroly načítá data v `React.useEffect(..., [])`, tedy jen při mountu.
- Je možné, že chybí auto-refresh/polling, ruční refresh dat, nebo se data zahodí kvůli chybě v API base URL, auth hlavičce, CORS, mapování payloadu nebo filtrování syntetických objektů.

## Úkol

Najdi a oprav příčinu, proč se syntetické tracky ze SIM nezobrazují v COP webu.

Postupuj takto:

1. V projektu COP ověř aktuální stav API:

   ```bash
   cd /srv/cop
   docker compose ps
   curl -fsS http://localhost:4310/health/ready
   curl -fsS \
     -H "Authorization: Bearer dev-lab-token" \
     "http://localhost:4310/api/v1/cop/tracks?includeSynthetic=true"
   curl -fsS \
     -H "Authorization: Bearer dev-lab-token" \
     "http://localhost:4310/api/v1/sources"
   ```

2. Ověř v prohlížeči `http://docker.home.cz:4311`, jestli COP web volá správné API `http://docker.home.cz:4310`, posílá `Authorization: Bearer dev-lab-token` a dostává tracky.

3. Pokud web data vůbec nenačítá nebo načítá jen jednorázově, doplň do COP webu:

   - ruční refresh dat,
   - automatické pravidelné načítání COP sources a tracks, například každé 3 až 5 sekund,
   - viditelný stav posledního načtení nebo chyby,
   - zachování zobrazení posledních platných dat při dočasné chybě API.

4. Pokud web data dostává, ale nezobrazuje je, oprav mapování nebo filtrování:

   - syntetické objekty musí být viditelné při `includeSynthetic=true`,
   - objekty ze zdroje `sim-air-situation-001` se nesmí omylem filtrovat pryč,
   - confidence threshold nesmí skrýt validní testovací objekty,
   - UI má jasně označit syntetické objekty jako syntetická data.

5. Doplň přiměřené testy podle existujícího testovacího setupu COP projektu. Minimálně otestuj, že webová vrstva umí zobrazit tracky vrácené z `/api/v1/cop/tracks?includeSynthetic=true`.

6. Znovu nasaď COP na `docker.home.cz` z `/srv/cop`:

   ```bash
   cd /srv/cop
   docker compose up -d --build
   ```

7. Proveď end-to-end ověření:

   - spusť SIM UI na `http://docker.home.cz:5020`,
   - spusť demo scénář tlačítkem `Start`,
   - otevři COP web `http://docker.home.cz:4311`,
   - ověř, že se syntetické objekty objeví bez ručního zásahu, nejpozději po dalším polling intervalu.

## Kritéria dokončení

- COP API stále vrací syntetické SIM tracky.
- COP web zobrazuje tracky ze SIM.
- COP web se průběžně aktualizuje nebo má jasné tlačítko refresh.
- Při výpadku API se uživateli zobrazí chyba, ale poslední validní data se zbytečně nesmažou.
- Změny jsou commitnuté v COP repozitáři.
- Pokud jsou potřeba `sudo` příkazy, pouze je vypiš uživateli; nespouštěj je za něj.

## Poznámka

Neměň SIM publisher, dokud nedoložíš, že chyba je skutečně na straně SIM. Dosavadní ověření ukazuje, že SIM publikuje správně a COP API ingest funguje.
