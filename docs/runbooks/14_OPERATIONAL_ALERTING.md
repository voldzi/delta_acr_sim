# Operational Alerting

**Stav 10. 10. 2026:** rozšířený hostový monitor je nainstalovaný, jeho cron je
aktivní a report se publikuje do skutečného bindu SIM API. Úplná akceptace přes
autentizované API/UI a minimální ochrana proti zastaralému reportu se dokončují
podle [ADR 0032](../adr/0032_VALHALLA_READ_ONLY_OPERATIONAL_MONITOR.md).
Zvoleným notifikačním kanálem je **pouze přihlášené SIM UI**; nezřizuje se nový
Codex heartbeat, e-mail ani push. Instalace monitoru není důkazem načtení alertu
v aplikaci. Nasazenou revizi, hash monitoru a akceptační důkazy je nutné doplnit
po skutečném ověření; ochranu čtení reportu zatím neoznačujte za nasazenou.

## Purpose

SIM production uses a host-level operational check for the server-to-server data
plane consumed by COP. The check is intentionally outside the browser UI and
does not expose new public endpoints.

It verifies:

- SLO for `GET /health/live` and `GET /api/v1/operations/summary`,
- production readiness rollup from `operations/summary`,
- nginx gateway live state and provider access-control behavior,
- provider contract smoke checks for `flight-data`, `situation-data`,
  `safety-data` and `tak-gateway`,
- OSM/PostGIS and administrative boundary read-model availability,
- Safety Data administrative boundary availability,
- DEM catalog readiness with local and SeaweedFS tile counts,
- terrain-aware mobile coverage read-model output,
- `mobile_network` output backed by the prepared read-model,
- situation-data density grid output for low-zoom COP rendering,
- repeated radio-planning `link-check` cache telemetry,
- that public `/metrics` remains hidden by the web gateway.

Health `routing.status=ok` v Situation Data prokazuje dostupnost Valhally, nikoli
čerstvost map ani úspěch aktualizace. Běžná vozidlová trasa může být odmítnuta
pro starý graf, přestože tento health signál zůstává `ok`. Samostatná provozní
kontrola Valhally níže má tento rozdíl zachytit; nemění routovací pravidla a
nespouští skutečná měření Jízdy. Ruční routovací akceptace je oddělená od
pravidelné read-only sondy.

`tak-gateway` is a future module in the current pilot. SIM still shows its
diagnostic state, but `operations/summary` marks it with
`productionReadiness=false`, so it does not degrade the production readiness
rollup or SLO. The contract smoke still checks the gateway routes and allows
the TAK health endpoint to be degraded.

## One-Shot Check

Základní monitor lze spustit z `/srv/sim` na `docker.home.cz`:

```bash
python3 scripts/production-operational-check.py --env-file .env --json
```

Základní verze bez přepsané konfigurace zapisuje:

```text
data/operational-checks/latest.json
data/operational-checks/state.json
```

It exits with code `0` only when all required checks pass.

Pro nainstalované rozšíření použijte jeho izolovanou verzi a oddělenou
hostovou konfiguraci, nikoli starší kopii v runtime checkoutu:

```bash
SIM_OPERATIONAL_ROOT=/srv/sim python3 \
  /home/voldzi/sim-owned-deploy/valhalla-monitor-20261010/scripts/production-operational-check.py \
  --env-file /srv/sim/.env \
  --monitor-env-file /srv/sim/data/operational-checks/monitor.env --json
```

`SIM_OPERATIONAL_ROOT` vymezuje runtime a read-only smoke závislosti; cesta ke
skriptu určuje testovanou implementaci monitoru. `.env` se nepřepisuje.

### Report skutečně viditelný v SIM

Ověření 10. 10. 2026 zjistilo rozdíl mezi hostovým adresářem reportů
`/srv/sim/data/operational-checks/` a skutečným bind mountem kontejneru
`csm-sim-api`: `/srv/x5-production/data/csm-sim/sim-data` → `/data`.
API mělo nastaveno `SIM_OPERATIONS_REPORT_FILE=/data/operational-checks/latest.json`,
ale tento soubor v kontejneru chyběl. Existující UI proto nevidělo výsledek
hostového monitoru. Existence cron jobu sama o sobě neprokazuje funkční dohled.

Nainstalovaná oprava publikuje bounded sanitizovaný report atomicky do skutečného
API bind adresáře:

```text
/srv/x5-production/data/csm-sim/sim-data/operational-checks/latest.json
```

Stav deduplikace zůstává na zálohovaném hostovém úložišti:

```text
/srv/sim/data/operational-checks/state.json
```

Před **každým** zápisem na X5 musí být ověřen samostatný mount a UUID
`2f93f595-b61b-4eea-9054-7afa9b275b5b`; chybějící či jiný mount ukončí
publikování bez zápisu do podkladového interního disku. Nestačí guard při
instalaci cronu. Zápis používá dočasný soubor a atomickou výměnu ve stejném
adresáři, aby UI nečetlo rozpracovaný JSON. Report nesmí obsahovat raw zdrojová
data, GPS, osobní identifikátory, klíče ani přístupové údaje v URL.

Nezaměňujte hostový `SIM_OPERATIONAL_REPORT_FILE` s API nastavením
`SIM_OPERATIONS_REPORT_FILE`; API používá cestu uvnitř kontejneru. Cílový mount
ověřte při nasazení, neodvozujte jej jen z verzovaného Compose. Samotné propojení
reportu nevyžaduje restart API, Situation Data API nebo webu.

### Ochrana proti zastavení monitoru — připravená API změna

Pouze správný bind nestačí: zastavený cron nesmí zanechat starý zelený report.
Minimální změna existujícího readeru v `operations-summary.ts` proto pro
**konfigurovaný** report vyvolá stávající `operational_check_failed`, když
soubor chybí, je neplatný, je starší než 15 minut nebo má čas více než 30 sekund
v budoucnosti. Čtení je omezené na 128 KiB. Chyby mají pevné sanitizované texty;
do odpovědi/logu se nepřenáší obsah chybného souboru, cesty ani podrobnosti
výjimky. Nevzniká nový endpoint, schema ani vlastnost odpovědi.

Nasazení tohoto guardu je oddělené od hostového monitoru: odvozený obraz smí
vycházet pouze z přesné immutable identity aktuálního main API obrazu a změnit
jen zkontrolovaný `operations-summary.ts` a jeho zkompilovaný modul. Všechny
ostatní aplikační soubory, knihovny, flags, síť a Situation Data API se zachovají.
Před cíleným restartem pouze `sim-api` ověřte shodu zdrojového souboru s běžícím
obrazem a zaznamenejte identity původního/odvozeného obrazu i rollback manifest.
Tento postup není full-stack build ani deploy staršího runtime checkoutu.

## Read-only dohled Valhally

Perioda je pět minut. Sonda čte výhradně pevný maintenance příkaz `status`:
stav týdenní služby a timeru, metadata posledního pokusu/úspěchu, aktivního
grafu, healthchecku a disku. Nevolá routy, neobnovuje traffic lease, nezapisuje
traffic mapu a automaticky nespouští ani nerestartuje build.

| Podmínka | Požadovaný signál monitoru |
| --- | --- |
| Aktivní mapy staré alespoň 8 dnů a méně než 9 dnů | `warning`: časná výstraha před routovacím limitem |
| Aktivní mapy staré alespoň 9 dnů | `critical`: zásah před dosažením současného 10denního routovacího limitu |
| Selhaný poslední týdenní pokus | `critical` při nejbližší sondě, bez čekání na stáří map |
| Týdenní timer není aktivní | `critical` při nejbližší sondě |
| Probíhající sestavení trvá více než 6 hodin | `critical`: podezření na uvázlé sestavení; sonda je sama nezastaví |
| Status nelze získat nebo jednoznačně vyhodnotit | Výslovná chyba dohledu, nikoli `ok` |

Hranice jsou v monitoru, nikoli změnou přijatelného stáří routovacího grafu.
`warning` a `critical` v diagnostice monitoru zůstávají odlišné. Existující
SIM API však z neúspěšného celkového reportu vytváří obecný
`operational_check_failed` se závažností `critical` a se shrnutím příčiny.
Samostatný Valhalla alert kód nebo jiný rollup UI není součástí tohoto
monitor-only nasazení. Funkční navigaci nelze odvodit z pouhé absence alertu.

### Vyhrazené SSH oprávnění

Klíč vznikne přímo na `docker.home.cz` pro tento monitor. Privátní klíč zůstává
výhradně v chráněných produkčních secrets, mimo Git, X5 a aplikační obrazy.
Na Valhalle je jeho veřejná část omezena forced commandem na existující
maintenance wrapper s **pevným `status`**, bez shellu, mutujících akcí, PTY,
agent/X11 forwarding či port forwardingu. Klíč nesmí být používán pro updater,
instalaci, čištění ani běžný přístup správce.

SSH sonda má ověřený/připnutý host key, neinteraktivní přihlášení a omezený čas
i velikost odpovědi. Raw výstup a privátní klíč se nezapisují do reportu nebo
logu; parsují se jen dovolená stavová pole. V produkčních secrets se ukládá
také potřebná SSH konfigurace. Připravený instalační skript přidává pouze
omezenou veřejnou identitu do uživatelova `authorized_keys`; stávající
maintenance wrapper ani jeho sudoers oprávnění nerozšiřuje.

### Instalace oddělená od release aplikace

Na Macu ze SIM repozitáře:

```bash
bash scripts/setup-valhalla-monitor-access.sh --install
```

Skript vytvoří klíč na **docker.home.cz**, nikoli na Macu, v
`~/.config/csm-sim/valhalla-monitor/id_ed25519`. Privátní soubor má práva 600,
adresář 700; mezi hosty putuje jen veřejná část. Následně ověří fixed-status
přístup. Ověřený SSH přístup není důkazem nainstalovaného periodického monitoru.

Testované monitorovací soubory žijí na Docker hostu výhradně v:

```text
/home/voldzi/sim-owned-deploy/valhalla-monitor-20261010/scripts/
```

Runtime Git checkout `/srv/sim` ani jeho zdrojové soubory se nepřepisují.
Před instalací musí správce zpřístupnit pouze cílovou podsložku
`/srv/x5-production/data/csm-sim/sim-data/operational-checks` pro zápis monitoru,
nikoli rekurzivně měnit vlastníka celého API data adresáře. Správce tuto konkrétní
podsložku vytvořil a zpřístupnil; instalátor při chybějících právech skončí bez
aktivace.

Potom na Docker hostu:

```bash
SIM_OPERATIONAL_ROOT=/srv/sim bash \
  /home/voldzi/sim-owned-deploy/valhalla-monitor-20261010/scripts/install-valhalla-operational-monitor.sh
```

Instalátor nejprve ověří X5, cílová práva a privátní klíč a provede izolované
testy monitoru. Zapíše oddělený `monitor.env` s právy 600 a zachová zálohu
existující konfigurace. Pomocí své verze
`install-production-operational-check-cron.sh` nastaví jen vyhrazený SIM cron
blok; ostatní joby zachová. Nepoužívá plný deploy/Compose ani restart služby.

## Alerting

Alert delivery is state-change based by default:

- first failure sends an alert,
- repeated identical failures are deduplicated,
- changed failure fingerprint sends another alert,
- recovery from failure sends an informational recovery alert.

The SLO probe ignores only the previous `operational_check_failed` alert from
`operations/summary`, so a recovered system can clear an older failed report.
Other `critical` or `warning` alerts remain blocking.

Without a webhook, failures and recoveries are still written to syslog through
`logger -t csm-sim-operational-check` and to the JSON report/state files.

**Syslog není push ani potvrzené doručení člověku.** Uživatel zvolil upozornění
jen v přihlášeném SIM Overview / Alert inboxu. Syslog a lokální JSON slouží jako
provozní evidence. Žádný nový Codex heartbeat, e-mail ani externí push se
nevytváří; aplikaci je nutné otevřít. Zobrazení alertu je třeba ověřit zvlášť od
zápisu reportu. Níže popsaný volitelný webhook není aktivovaný a vyžadoval by
nový výslovný souhlas a samostatnou akceptaci.

Optional generic JSON webhook:

```env
SIM_OPERATIONAL_ALERT_WEBHOOK_URL=https://alert-endpoint.example.invalid/sim
SIM_OPERATIONAL_ALERT_ENVIRONMENT=docker-home
SIM_OPERATIONAL_ALERT_ON_RECOVERY=true
SIM_OPERATIONAL_ALERT_EVERY_FAILURE=false
```

The webhook receives a JSON object containing `eventType`, `environment`,
`host`, `status`, `severity`, `summary`, `failures` and the full bounded report.
Do not put webhook secrets into Git.

## Periodic Cron

Install the user crontab entry on `docker.home.cz`:

```bash
cd /srv/sim
scripts/install-production-operational-check-cron.sh
```

Pro rozšířený Valhalla monitor použijte izolovaný instalátor v předchozí sekci,
nikoli starší kopii instalátoru v runtime checkoutu. Jeho cron každých pět
minut spouští `run-production-operational-check.sh` ze stejného izolovaného
adresáře. Runner ověří X5 **před redirekcí logu**, čte oddělený `monitor.env` a
pomocí `flock` zabrání překryvu běhů. Celkový běh má `timeout 240` sekund.

Na produkčním `/srv/sim` se obnovitelný `cron.log` ukládá na X5 do
`/srv/x5-production/cache/csm-sim/operational-checks`. Základní instalátor před
změnou crontabu ověří UUID X5. Připravované rozšíření musí guard provést i při
každém běhu před otevřením souboru na X5; shellová redirekce před guardem není
bezpečná. Stav deduplikace zůstává na zálohovaném hostovém úložišti, report pro
UI se publikuje do skutečného API bind adresáře uvedeného výše.

Default schedule:

```text
*/5 * * * *
```

Override when needed:

```bash
SIM_OPERATIONAL_CRON_SCHEDULE='*/2 * * * *' scripts/install-production-operational-check-cron.sh
```

Remove:

```bash
scripts/install-production-operational-check-cron.sh --uninstall
```

Cron output is appended to:

```text
/srv/x5-production/cache/csm-sim/operational-checks/cron.log
```

## Production Configuration

`scripts/deploy-docker-home.sh` preserves these values from an existing
`/srv/sim/.env`:

```env
SIM_OPERATIONAL_ALERT_WEBHOOK_URL=
SIM_OPERATIONAL_ALERT_ENVIRONMENT=docker-home
SIM_OPERATIONAL_BASE_URL=http://127.0.0.1:5020
SIM_OPERATIONAL_API_TOKEN=
SIM_OPERATIONAL_CHECK_BBOX=11.8,48.5,19.2,51.2
SIM_OPERATIONAL_BOUNDARY_BBOX=12,48,19,51
SIM_OPERATIONAL_TERRAIN_BBOX=13.95,50.55,14.08,50.65
SIM_OPERATIONAL_EXPECTED_DEM_SOURCE=copernicus-glo30-cz
SIM_OPERATIONAL_EXPECTED_MOBILE_MODEL_VERSION=coverage-v2-terrain
SIM_OPERATIONAL_REQUIRE_DEM=true
SIM_OPERATIONAL_REQUIRE_TERRAIN_AWARE=true
SIM_OPERATIONAL_ALERT_ON_RECOVERY=true
SIM_OPERATIONAL_ALERT_EVERY_FAILURE=false
SIM_OPERATIONAL_SLO_AVAILABILITY_TARGET=0.995
SIM_OPERATIONAL_CHECK_INTERVAL_SECONDS=300
SIM_OPERATIONAL_SLO_MAX_LIVE_LATENCY_MS=1000
SIM_OPERATIONAL_SLO_MAX_SUMMARY_LATENCY_MS=3000
SIM_OPERATIONAL_SLO_MAX_TOTAL_DURATION_MS=180000
SIM_OPERATIONAL_SLO_REQUIRE_OPERATIONS_OK=true
```

The check reads `.env` as a plain key/value file. It does not shell-source it,
so values such as `VITE_SIM_OIDC_SCOPE=openid profile email` are safe.
`SIM_OPERATIONAL_API_TOKEN` is optional; when it is empty, the check falls back
to `SIM_API_INTERNAL_TOKEN` and then `SIM_API_ADMIN_TOKEN` so protected SIM API
probes can run on authenticated production deployments. The token itself is not
written to the JSON report.

### Oddělená hostová konfigurace rozšíření

`/srv/sim/data/operational-checks/monitor.env` má práva 600 a obsahuje jen pět
povolených klíčů:

```env
SIM_OPERATIONAL_VALHALLA_MONITOR_ENABLED=true
SIM_OPERATIONAL_VALHALLA_MONITOR_KEY=~/.config/csm-sim/valhalla-monitor/id_ed25519
SIM_OPERATIONAL_REPORT_FILE=/srv/x5-production/data/csm-sim/sim-data/operational-checks/latest.json
SIM_OPERATIONAL_STATE_FILE=/srv/sim/data/operational-checks/state.json
SIM_OPERATIONAL_ALERT_REMINDER_SECONDS=86400
```

`--monitor-env-file` připojí pouze tento allowlist, nikoli API tokeny, webhook
URL nebo jiná oprávnění. Základní token se dál načítá z původního `/srv/sim/.env`
a neexportuje se. Výchozí monitor flag mimo tuto oddělenou konfiguraci zůstává
`false`. Perioda je 300 s; prahy warning 8 dnů, critical 9 dnů a stuck-build
více než 6 hodin se nesmějí zaměňovat s routovací konfigurací.

Interval 86400 s je připomenutí přetrvávající chyby, nikoli doklad, že existuje
vnější kanál. `alertDelivery.userNotificationDelivered` se eviduje zvlášť od
`sent`: samotný úspěšný syslog jej nenastaví. Zvolený UI-only režim tento údaj
nenastavuje jen na základě publikace reportu. Webhook není aktivovaný; chybu/retry
a recovery případného vnějšího kanálu ověřte až po novém výslovném schválení.

## Expected Passing Signals

Important report fields:

```json
{
  "status": "ok",
  "checks": {
    "demHealth": {
      "status": "ok",
      "tileCount": 36,
      "localTileCount": 36,
      "objectStoreTileCount": 36
    },
    "terrainAwareMobileCoverage": {
      "status": "ok",
      "modelVersion": "coverage-v2-terrain",
      "demSource": "copernicus-glo30-cz",
      "terrain": {
        "terrainAware": true,
        "terrainDataAvailable": true,
        "terrainApplied": true
      }
    },
    "operationsSlo": {
      "status": "ok",
      "liveLatencyMs": 12,
      "summaryLatencyMs": 240,
      "authenticated": true,
      "productionReadinessServices": 3,
      "futureServicesExcluded": 1
    }
  }
}
```

## Manual Diagnosis

When the periodic check fails:

```bash
cd /srv/sim
tail -n 100 /srv/x5-production/cache/csm-sim/operational-checks/cron.log
python3 -m json.tool data/operational-checks/latest.json
curl -fsS http://127.0.0.1:5020/situation-data/health/ready | python3 -m json.tool
```

If only the alert webhook failed but all checks are `ok`, the data plane is
healthy and the alert transport should be fixed separately.

## Akceptace a návrat monitoru a cíleného API guardu

Před označením změny za nasazenou ověřte hash instalovaného monitoru, skutečný
cron a omezenou SSH identitu. Testy musejí pokrýt hranice 8/9 dnů, failed pokus,
neaktivní timer, build nad 6 hodin, timeout/neplatný status, deduplikaci a recovery.
Pomocí izolované fixture prokažte také odmítnutí mutující SSH akce; nepokoušejte
se kvůli testu mutovat skutečnou Valhallu.

Na skutečné cestě ověřte zápis kompletního reportu ve správném bind adresáři a
jeho načtení autentizovaným `GET /api/v1/operations/summary`, včetně příslušného
obecného alertu v SIM. Samostatně otestujte missing/invalid/oversized/stale/future
report a čerstvý platný report; při zastavení monitoru nesmí zůstat stav zelený.
Odlišujte parser/fixture testy, instalaci, živý readback a vizuální akceptaci v
SIM. Vnější notifikace není součástí zvoleného režimu. Existující nesouvisející závady
mobilního read-modelu či latency SLO nezakrývejte, aby monitor vypadal zeleně.

Při rollbacku vraťte pouze zazálohované monitorovací soubory a jeho konfiguraci,
případně odstraňte jen nový dedikovaný veřejný klíč. Zachovejte ostatní cron
joby, aplikační obrazy, data a provozní historii. Monitorový rollback nerestartuje
žádné API/SDA/web ani Valhallu. API guard má vlastní rollback na zaznamenaný
původní immutable obraz s restartem pouze `sim-api`; původní obraz opět nemá
ochranu stáří/missing reportu, což musí být výslovně uvedeno. Rollback nemění
`DRIVER_MEASUREMENTS_ENABLED`, routingové limity,
traffic overlay nebo produkční síť. Další aktivace Jízdy a živá routovací
akceptace mají samostatné podmínky.
