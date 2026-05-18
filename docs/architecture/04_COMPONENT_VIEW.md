# Component view

**Status:** Baseline dokumentace

```mermaid
flowchart LR
    API["Simulator API"] --> ScenarioService["Scenario Service"]
    API --> RuntimeService["Runtime Service"]
    API --> PublisherService["Publisher Service"]
    API --> AIService["AI Draft Service"]
    API --> FaultService["Fault Service"]

    RuntimeService --> Scheduler["Simulation Scheduler"]
    Scheduler --> Aircraft["air-sim-aircraft"]
    Scheduler --> UAV["air-sim-uav"]
    Scheduler --> Missile["air-sim-missile"]
    Scheduler --> Friendly["ground-sim-friendly"]
    Scheduler --> Rescue["rescue-sim"]
    Scheduler --> Report["report-sim"]

    Aircraft --> EventFactory["Canonical Event Factory"]
    UAV --> EventFactory
    Missile --> EventFactory
    Friendly --> EventFactory
    Rescue --> EventFactory
    Report --> EventFactory
    EventFactory --> SchemaValidator["Schema Validator"]
    SchemaValidator --> FaultPipeline["Fault Pipeline"]
    FaultPipeline --> Queue["Publisher Queue"]
```

## Komponentové pravidlo

Každý simulační blok vrací pouze syntetické domain eventy. Canonical envelope, syntetické označení, idempotency metadata a publisher rozhodnutí se přidávají mimo blok, aby byl kontrakt jednotný.
