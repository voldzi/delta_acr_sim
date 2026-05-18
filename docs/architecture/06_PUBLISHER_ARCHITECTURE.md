# Publisher architecture

**Status:** Baseline dokumentace

Publisher je samostatná komponenta odpovědná za validaci, persistentní uložení, idempotency, retry/backoff, batch sending, dry-run a dohled nad publikací do COP.

```mermaid
flowchart LR
    Event["Synthetic simulator event"] --> Envelope["Canonical envelope builder"]
    Envelope --> Validate["JSON Schema validation"]
    Validate --> Synthetic["SYNTHETIC marking check"]
    Synthetic --> Queue["Persistent publisher queue"]
    Queue --> Mode{"Mode"}
    Mode -->|"dry-run"| DryRun["Record as validated, not sent"]
    Mode -->|"mock"| Mock["Mock COP endpoint"]
    Mode -->|"live"| Client["COP ingest client"]
    Client --> COP["COP ingest API"]
    COP --> Response["Response handler"]
    Mock --> Response
    Response --> Retry{"Retryable?"}
    Retry -->|"yes"| Backoff["Exponential backoff + jitter"]
    Backoff --> Queue
    Retry -->|"no"| DLQ["Dead-letter queue"]
    Response --> Metrics["Metrics & audit"]
```

## Zásady

- Nevalidní event nesmí opustit SIM proces.
- Každý event má `eventId`, `correlationId`, `X-Idempotency-Key` a `producerTimestamp`.
- Retry musí respektovat rate limit a `Retry-After`, pokud ho COP vrátí.
- Okamžité zastavení publikace musí zastavit live odesílání, ale nesmí smazat queue.
