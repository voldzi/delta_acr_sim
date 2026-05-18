# Fault injection panel

**Status:** Baseline dokumentace

## Funkce

- přidat fault
- upravit čas začátku a délku
- vybrat target block
- zobrazit aktivní faults
- audit změn
- preview dopadu na event stream

## Typy

- delay
- duplicate events
- source outage
- conflicting observations
- degraded accuracy
- reconnect burst
- batch replay

## Validace

UI musí validovat fault proti `fault-injection.schema.json` a upozornit na souběhy s vysokým event rate.
