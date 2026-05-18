# Roles and permissions

**Status:** Baseline dokumentace

## Role

- `SIM_ADMIN`
- `SIM_OPERATOR`
- `SIM_VIEWER`
- `SIM_AI_USER`
- `SIM_AI_ADMIN`

## Baseline oprávnění

- `SIM_VIEWER`: čtení scénářů, runtime a monitoringu.
- `SIM_OPERATOR`: spouštění, pozastavení a zastavení validovaných scénářů.
- `SIM_ADMIN`: konfigurace publisheru, secrets reference a queue operace.
- `SIM_AI_USER`: tvorba AI draftů v povolených limitech.
- `SIM_AI_ADMIN`: konfigurace AI providerů a external-provider policy.

## Citlivé akce

Změna publisher konfigurace, clear queue, external AI enablement a live publishing vyžadují audit a vyšší roli.
