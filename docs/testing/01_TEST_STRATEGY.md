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

The 2 Oct 2026 production-off rollout and separate PostgreSQL/fault evidence are
recorded in [deployment acceptance](../archive/2026-10-02_DRIVER_MEASUREMENTS_DEPLOYMENT_ACCEPTANCE.md).
Internal HTTP checks never turn on genuine journey collection. Restore guards
must fail with a nonzero exit on a different database before truncation.
