# Scenario engine architecture

**Status:** Baseline dokumentace

Scenario engine řídí lifecycle scénáře, časování bloků, deterministický seed, update rate a předání eventů do publisher pipeline.

```mermaid
flowchart TD
    Draft["Scenario DRAFT"] --> Validate["Schema + safety validation"]
    Validate --> Ready["READY"]
    Ready --> Start["START command"]
    Start --> Running["RUNNING"]
    Running --> Tick["Scheduler tick"]
    Tick --> Blocks["Simulation blocks"]
    Blocks --> Faults["Fault injection pipeline"]
    Faults --> Publisher["Publisher queue"]
    Running --> Pause["PAUSE"]
    Pause --> Paused["PAUSED"]
    Paused --> Resume["RESUME"]
    Resume --> Running
    Running --> Stop["STOP"]
    Stop --> Stopped["STOPPED"]
    Running --> Error["ERROR"]
    Error --> Reset["RESET"]
    Reset --> Ready
```

```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> READY: validate
    READY --> RUNNING: start
    RUNNING --> PAUSED: pause
    PAUSED --> RUNNING: resume
    RUNNING --> STOPPED: stop
    PAUSED --> STOPPED: stop
    STOPPED --> READY: reset
    RUNNING --> ERROR: runtime failure
    ERROR --> READY: reset
```

## Determinismus

Scénář je reprodukovatelný pouze při stejné verzi engine, stejné konfiguraci bloků, stejném seed a stejné konfiguraci fault injection. Tyto hodnoty musí být součástí runtime audit záznamu.
