# Scenario control

**Status:** Baseline dokumentace

## Runtime ovládání

- start
- pause
- resume
- stop
- reset
- step mode
- dry-run mode

## Stavové požadavky

Control panel musí jasně ukazovat runtime state, active scenario, generated events, published events, queued events, active faults a publisher mode.

## Bezpečnostní brzda

UI musí mít jasnou akci pro okamžité zastavení publikace. Tato akce zastaví odesílání do COP, ale nemaže frontu ani audit.
