# Aircraft simulator

**Status:** Baseline dokumentace

## Účel

Generuje syntetické aircraft tracky pro testování ingestu, aktualizací polohy, ztráty tracku a obnovy.

## Data

- object ID
- platform type
- affiliation
- lat/lon
- altitude
- speed
- heading
- vertical rate
- status
- position accuracy
- confidence
- source metadata

## Scénáře

- direct transit
- patrol pattern
- circular pattern
- entry/exit from AOI
- temporary track loss
- track restoration

## Omezení

Generátor nesmí modelovat taktické manévry, targeting ani reálné bojové doporučení.
