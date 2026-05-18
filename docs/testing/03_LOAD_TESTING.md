# Load testing

**Status:** Baseline dokumentace

## Cíle

- 1 000 aktivních tracků v MVP
- 1 000 zpráv/s v laboratorním režimu
- měření queue growth
- měření ingest latency
- test reconnect burst a batch sync

## Limity

Load testy musí používat syntetická data a explicitní limity object count, duration a update rate. Výsledky se ukládají jako laboratorní metriky, ne jako garance produkčního COP výkonu.
