# Missile track simulator

**Status:** Baseline dokumentace

## Účel

Generuje zjednodušené syntetické missile-track objekty pro ověření ingestu krátce žijících rychlých tracků a event rate. Nejde o fyzikální nebo taktické modelování.

## Data

- track ID
- `objectType: MISSILE_TRACK`
- lat/lon
- altitude
- speed
- heading
- simplified phase/state
- confidence
- timestamp

## Omezení

- Trajektorie jsou zjednodušené a laboratorní.
- Nepoužívají se modely navádění.
- Nepoužívá se modelování účinnosti.
- Neobsahuje reálné taktické doporučení ani plánování zásahu.
