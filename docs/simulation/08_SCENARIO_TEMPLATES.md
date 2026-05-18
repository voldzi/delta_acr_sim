# Scenario templates

**Status:** Baseline dokumentace

## MVP šablony

- Air Situation Basic: 20 aircraft, 50 UAV, 5 missile tracks, 15 minut, 1 Hz.
- Degraded Connectivity: výpadek publisheru po 5 minutách, lokální queue, batch sync po obnově.
- Conflicting Tracks: dva bloky generují podobný syntetický objekt s rozdílnou polohou.
- Source Loss and Recovery: výpadek `air-sim-uav` a následná obnova.
- High Load Demo: 500 aircraft, 1 000 UAV, 100 missile tracks a nastavitelný update rate.

## Ukládání

Šablony mají být v implementačním kroku reprezentované jako validní JSON scénáře a testované proti `scenario.schema.json`.
