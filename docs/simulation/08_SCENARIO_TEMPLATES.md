# Scenario templates

**Status:** Baseline dokumentace

## MVP šablony

- Air Situation Basic: 20 aircraft, 50 UAV, 5 missile tracks, 15 minut, 1 Hz.
- Degraded Connectivity: výpadek publisheru po 5 minutách, lokální queue, batch sync po obnově.
- Conflicting Tracks: dva bloky generují podobný syntetický objekt s rozdílnou polohou.
- Source Loss and Recovery: výpadek `air-sim-uav` a následná obnova.
- High Load Demo: 500 aircraft, 1 000 UAV, 100 missile tracks a nastavitelný update rate.
- Ukraine Air Defense Demo 2026-05-13: syntetická neoperativní ukázka nad Ukrajinou s červenými příletovými tracky, modrými obrannými interceptory a párovým ukončením zhruba 90 % červených cílů v místě střetu. Trasy jsou ilustrační a nesmí být prezentované jako rekonstrukce ani jako taktické doporučení.

## Ukládání

Šablony mají být v implementačním kroku reprezentované jako validní JSON scénáře a testované proti `scenario.schema.json`.
