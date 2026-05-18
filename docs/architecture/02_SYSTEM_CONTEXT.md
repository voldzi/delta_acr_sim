# System context

**Status:** Baseline dokumentace

SIM je samostatná aplikace a vůči COP vystupuje jako externí datový zdroj. COP není součástí tohoto repozitáře.

```mermaid
flowchart LR
    Operator["SIM operator / tester"] --> UI["Simulator Web UI"]
    Developer["COP developer"] --> UI
    UI --> API["Simulator API"]
    API --> Engine["Scenario Engine"]
    API --> AI["AI Scenario Assistant"]
    Engine --> Publisher["Publisher Queue & Client"]
    Publisher -->|"Shared Integration Contract v1"| COP["Main COP Ingest API"]
    AI --> Providers["OpenAI / Codex / Local LLM / Mock"]
    API --> Metrics["Health, metrics, audit logs"]
```

## Odpovědnosti SIM

- Generuje syntetická data a označuje je jako `SYNTHETIC`.
- Validuje scénáře, eventy a AI návrhy proti schématům.
- Publikuje nebo dry-runuje eventy podle konfigurace.
- Vede audit runtime, publisheru a AI operací.

## Odpovědnosti mimo SIM

- COP ingest, canonical fusion, COP state management a distribuce.
- Autorizace COP zdrojů na straně hlavního systému.
- NATO symbol rendering a downstream uživatelské workflow.
