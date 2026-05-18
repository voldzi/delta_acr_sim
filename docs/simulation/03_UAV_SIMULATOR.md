# UAV simulator

**Status:** Baseline dokumentace

## Účel

Generuje syntetické UAV/drone tracky pro test konektivity, degraded accuracy a zdrojových výpadků.

## Data

- UAV ID
- UAV class
- lat/lon
- altitude
- speed
- heading
- connection status
- optional battery/fuel state
- optional signal quality
- confidence

## Scénáře

- loiter
- survey pattern
- low-speed movement
- degraded position accuracy
- source outage
- restoration

## Omezení

UAV blok nesmí obsahovat navádění, útok, vyhýbání detekci ani optimalizaci proti protivníkovi.
