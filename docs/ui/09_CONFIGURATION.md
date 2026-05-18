# Configuration UI

**Status:** Baseline dokumentace

## Konfigurace

- COP base URL
- auth mode
- secret references
- sourceSystemId
- adapterVersion
- default classification
- default releasability
- dry-run/mock/live mode
- AI provider mode
- generation limits

## Pravidla

UI nezobrazuje tajné hodnoty. Změny konfigurace publisheru a externí AI vyžadují vyšší oprávnění a audit.

## Validace

Před uložením se validuje URL, povolený auth mode, sourceSystemId a limity generování.
