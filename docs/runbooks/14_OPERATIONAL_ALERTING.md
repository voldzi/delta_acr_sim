# Operational Alerting

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
- that public `/metrics` remains hidden by the web gateway.

`tak-gateway` is a future module in the current pilot. SIM still shows its
diagnostic state, but `operations/summary` marks it with
`productionReadiness=false`, so it does not degrade the production readiness
rollup or SLO. The contract smoke still checks the gateway routes and allows
the TAK health endpoint to be degraded.

## One-Shot Check

Run from `/srv/sim` on `docker.home.cz`:

```bash
python3 scripts/production-operational-check.py --env-file .env --json
```

The command writes:

```text
data/operational-checks/latest.json
data/operational-checks/state.json
```

It exits with code `0` only when all required checks pass.

## Alerting

Alert delivery is state-change based by default:

- first failure sends an alert,
- repeated identical failures are deduplicated,
- changed failure fingerprint sends another alert,
- recovery from failure sends an informational recovery alert.

Without a webhook, failures and recoveries are still written to syslog through
`logger -t csm-sim-operational-check` and to the JSON report/state files.

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
/srv/sim/data/operational-checks/cron.log
```

## Production Configuration

`scripts/deploy-docker-home.sh` preserves these values from an existing
`/srv/sim/.env`:

```env
SIM_OPERATIONAL_ALERT_WEBHOOK_URL=
SIM_OPERATIONAL_ALERT_ENVIRONMENT=docker-home
SIM_OPERATIONAL_BASE_URL=http://127.0.0.1:5020
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
tail -n 100 data/operational-checks/cron.log
python3 -m json.tool data/operational-checks/latest.json
curl -fsS http://127.0.0.1:5020/situation-data/health/ready | python3 -m json.tool
```

If only the alert webhook failed but all checks are `ok`, the data plane is
healthy and the alert transport should be fixed separately.
