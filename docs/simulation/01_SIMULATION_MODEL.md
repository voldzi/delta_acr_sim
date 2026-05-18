# Simulační model

**Status:** Baseline dokumentace

## Scenario

Scenario je verzovaný popis syntetického běhu. Obsahuje identitu, název, oblast, délku, seed, bloky, fault injection a metadata validace. Spustit lze pouze validovaný scénář.

## Scenario block

Scenario block definuje jeden generátor: `air-sim-aircraft`, `air-sim-uav`, `air-sim-missile`, `ground-sim-friendly`, `rescue-sim` nebo `report-sim`. Každý blok má `enabled`, `objectCount`, `updateRateHz`, `patterns` a blokově specifické parametry.

## Seed a reprodukovatelnost

Seed je povinný pro reprodukovatelné scénáře. Reprodukce vyžaduje stejný seed, stejnou konfiguraci, stejnou verzi engine a stejnou verzi bloků. Seed se ukládá do `simulation.seed` v event envelope.

## Area, duration a update rate

Area je v MVP BBOX `[minLon, minLat, maxLon, maxLat]`. Duration je v sekundách. Update rate definuje frekvenci generování eventů pro blok a musí mít limit, aby chránil runtime a publisher queue.

## Object count

Object count je počet syntetických objektů generovaných blokem. Limity jsou konfigurovatelné a AI návrhy je nesmí překročit.

## Typy dat

- Aircraft tracks: poloha, altitude, speed, heading, vertical rate, status, accuracy, confidence.
- UAV tracks: class, poloha, altitude, speed, heading, connection status, battery/fuel state, signal quality.
- Missile tracks: zjednodušený syntetický track bez navádění, účinnosti a taktických doporučení.
- Friendly force tracks: friendly ground tracks pro test korelace a situational display.
- Rescue incidents: krizové a záchranné incidenty bez bojového workflow.
- Manual reports: textová hlášení pro ingest a audit testy.

## Fault injection

Fault injection je časově omezená transformace event streamu. Musí být auditovatelná, deterministická a validovaná proti `fault-injection.schema.json`.

## Synthetic data marking

Každý event musí mít `classification.handlingCaveats` obsahující `SYNTHETIC` a `simulation.synthetic` nastavené na `true`. Event bez tohoto označení je nevalidní.
