# Dry-run mode runbook

**Status:** Baseline dokumentace

## Zapnutí

Nastavit publisher mode na `dry-run`. UI musí režim jasně zobrazit.

## Ověření

- spustit scénář
- zkontrolovat generated events
- zkontrolovat dry-run validated count
- ověřit žádné HTTP volání na COP
- zkontrolovat payload preview a synthetic marking

## Použití

Dry-run je výchozí režim pro lokální vývoj, AI draft ověření a contract payload preview.
