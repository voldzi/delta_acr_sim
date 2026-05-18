# Friendly force simulator

**Status:** Baseline dokumentace

## Účel

Generuje friendly ground tracks pro testování zobrazení, korelace a datové kvality bez napojení na reálné jednotky.

## Data

- object ID
- affiliation FRIEND nebo ASSUMED_FRIEND
- domain LAND
- lat/lon
- speed
- heading
- status
- confidence
- source metadata

## Scénáře

- slow movement
- checkpoint transition
- temporary stale status
- position accuracy degradation

## Bezpečnost

Blok nesmí obsahovat rozkazy, cíle, taktické postupy ani koordinaci bojové činnosti.
