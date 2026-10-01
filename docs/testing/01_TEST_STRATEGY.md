# Test strategy

**Status:** Baseline dokumentace

## Úrovně testů

- unit testy validátorů a generátorů
- contract testy OpenAPI/JSON Schema
- integration testy publisheru a mock COP
- load testy event rate a queue
- AI guardrail testy
- UI smoke testy
- acceptance testy MVP scénářů

## Priorita

První implementační krok má testovat kontrakty, publisher safety gates a AI guardrails dříve než bohaté UI chování.

## Graph-native traffic promotion

Run `python3 deploy/valhalla/test-native-canary-ab.py` and
`python3 deploy/valhalla/test-native-live-selection.py`, followed by the existing
traffic updater/expiry/physical-archive suites. The selection tests cover
default-off, root-only file ownership, strict approval, graph/static rotation,
changed graph/baseline, whole-edge/reference/cross-candidate conflicts and
fingerprint invalidation. A full synthetic archive activation/rollback test
preserves the baseline bytes and physically zeros the added edge on return.
The bound, private same-flow pilot is separate from fixture tests and does not
replace operator geographic acceptance or independent actual trip-time evidence.

## Consented driver measurements

Run `pnpm --filter @csm-sim/situation-data-api exec vitest run
test/driver-measurements.test.ts`. These synthetic tests cover input/auth/consent,
quality and direction guards, graph rotation/partial edges, exact replay,
limits, revocation and storage/matcher outages. They do not prove live ETA.

For actual PostgreSQL tests, provision a disposable dedicated database, never
a production database, and set `DRIVER_MEASUREMENTS_TEST_DATABASE_URL` for
`test/driver-measurement-store.test.ts`. The suite creates schema and a restricted
test role, truncates its own tables and drops the role afterward. It must not
run against SIM/COP/provider databases. Tests cover repeatable migration,
no-DDL runtime, transactions, deduplication, aggregation thresholds, dataset
separation, expiry and cascading revocation. The suite skips if no explicit
test URL is supplied; report that separately from executed tests.

Joint COP/Jízda consent/outbox and on-device acceptance, capacity/load testing
and independent direction/ETA evaluation remain production gates. See
[integration contract](../integration/20_JIZDA_DRIVER_MEASUREMENTS_CONTRACT.md).
