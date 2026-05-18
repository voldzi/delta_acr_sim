# Vize a rozsah

**Status:** Baseline dokumentace

## Vize

SIM poskytuje spolehlivý syntetický zdroj situačních dat pro vývoj a testování COP bez závislosti na reálných operačních zdrojích. Umožňuje reprodukovatelné scénáře, řízenou degradaci dat a bezpečné AI asistované návrhy.

## Rozsah

- Samostatná webová aplikace s UI a backend API.
- Scenario builder a scenario control pro syntetické scénáře.
- Simulační bloky pro aircraft, UAV, missile tracks, friendly force, rescue incidenty a manual reports.
- Fault injection a publisher monitor.
- Publisher do COP přes explicitní kontrakt, včetně dry-run a mock režimu.
- AI Scenario Assistant s provider abstraction a guardrails.

## Mimo rozsah

SIM není COP, neprovádí fusion, distribuci COP stavu, NATO rendering, targeting, navádění, zbraňové workflow ani bojové plánování.
