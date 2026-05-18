# Synthetic data safety

**Status:** Baseline dokumentace

## Cíl

Zabránit smíchání syntetických a reálných dat a znemožnit, aby SIM vypadal jako autoritativní operační zdroj.

## Kontroly

- povinné `SYNTHETIC` handling caveat
- `simulation.synthetic: true`
- sourceSystemId jasně identifikující simulátor
- payload bez osobních údajů a secrets
- AI redaction před externím providerem
- publisher reject pro event bez syntetického označení

## UI označení

UI musí u scénářů, event preview a publisher monitoru jasně zobrazovat, že jde o syntetická data.
