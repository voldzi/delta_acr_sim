# Fault injection architecture

**Status:** Baseline dokumentace

Fault injection je řízená vrstva mezi generováním syntetických eventů a publisher queue. Slouží k testování odolnosti COP ingestu, ne k modelování reálných útoků nebo taktických postupů.

```mermaid
flowchart LR
    Event["Generated event"] --> Match["Fault selector"]
    Match --> NoFault["No fault"]
    Match --> Delay["Delay"]
    Match --> Duplicate["Duplicate"]
    Match --> Outage["Source outage"]
    Match --> Conflict["Conflicting observation"]
    Match --> Degraded["Degraded accuracy"]
    Match --> Burst["Reconnect burst"]
    NoFault --> Queue["Publisher queue"]
    Delay --> Queue
    Duplicate --> Queue
    Outage --> DropOrStatus["Drop event or source.status.changed"]
    DropOrStatus --> Queue
    Conflict --> Queue
    Degraded --> Queue
    Burst --> Queue
```

## Povolené fault typy

- `DELAY`: zpoždění publikace.
- `DUPLICATE`: opakované doručení stejné idempotentní události.
- `SOURCE_OUTAGE`: výpadek zdroje a volitelný `source.status.changed` event.
- `CONFLICT`: syntetické konfliktní pozorování pro test COP korelace.
- `DEGRADED_ACCURACY`: zhoršená přesnost a confidence.
- `RECONNECT_BURST`: dávkové doručení po obnově.
- `BATCH_REPLAY`: řízený replay historicky uložených syntetických eventů.
