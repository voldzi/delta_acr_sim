# Synthetic data rules

**Status:** Baseline dokumentace

## Povinná pravidla

- Všechna data jsou laboratorní a syntetická.
- Každý event obsahuje `handlingCaveats: ["SYNTHETIC"]` nebo ekvivalentní rozšířený seznam s hodnotou `SYNTHETIC`.
- Každý event obsahuje `simulation.synthetic: true`.
- Žádné payloady nesmí obsahovat reálné osobní údaje, reálné operační údaje, secrets nebo interní tokeny.
- AI provider nesmí dostat neredigovaná reálná data.
- Syntetické missile-track objekty nesmí nést naváděcí, účinkové nebo targeting parametry.

## Validace

Synthetic data marking je schema gate i runtime gate. Publisher odmítne každý event bez syntetického označení.
