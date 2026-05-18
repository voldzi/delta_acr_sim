# Fault injection

**Status:** Baseline dokumentace

## Použití

Fault injection se používá pro testování ingest odolnosti, datové kvality, queue obnovy a degraded režimů. Nejedná se o simulaci reálného útoku.

## Konfigurace

- Fault má typ, targetBlockId, startAtSecond, durationSeconds a parameters.
- Fault je verzovaná součást scénáře a auditovaná změna.
- Souběžné faulty musí mít deterministické pořadí aplikace.
- Fault nesmí odstranit syntetické označení ani porušit canonical envelope.
