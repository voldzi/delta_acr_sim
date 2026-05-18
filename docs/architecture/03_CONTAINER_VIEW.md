# Container view

**Status:** Baseline dokumentace

```mermaid
flowchart TB
    subgraph Browser["Browser"]
        Web["Simulator Web UI"]
    end

    subgraph Simulator["SIM backend deployment"]
        API["Simulator API"]
        Engine["Scenario Engine"]
        Blocks["Simulation Blocks"]
        Faults["Fault Injection Engine"]
        AIGateway["AI Gateway & Guardrails"]
        Publisher["Publisher Queue & Client"]
        Store[("Scenario Store / Queue Store")]
        Obs["Logs, Metrics, Audit"]
    end

    subgraph External["External systems"]
        COP["COP Ingest API"]
        AIProviders["OpenAI / Codex / Local LLM"]
    end

    Web --> API
    API --> Engine
    Engine --> Blocks
    Engine --> Faults
    Blocks --> Publisher
    Faults --> Publisher
    API --> AIGateway
    AIGateway --> AIProviders
    Publisher --> COP
    API --> Store
    Publisher --> Store
    API --> Obs
    Publisher --> Obs
    AIGateway --> Obs
```

## Kontejnery

- `simulator-web`: UI pro dashboard, builder, control, publisher monitor, fault injection, konfiguraci a AI asistenta.
- `simulator-api`: REST API, auth enforcement, validation, runtime orchestration a audit.
- `simulation-core`: deterministický runtime a lifecycle scénáře.
- `simulation-blocks`: generátory syntetických bloků.
- `publisher-client`: persistent queue, idempotency, retry/backoff, dry-run a mock mode.
- `ai-assistant`: provider abstraction, guardrails, structured outputs a human review.
