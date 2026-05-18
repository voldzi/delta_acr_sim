# AI assisted scenario planning

**Status:** Baseline dokumentace

AI vrstva pomáhá pouze s návrhem syntetických scénářů, jejich vysvětlením, validací, fault injection návrhy, load test návrhy a dokumentací. AI nikdy nespouští scénář přímo a nesmí poskytovat reálné bojové plánování.

```mermaid
flowchart LR
    Prompt["User prompt"] --> Policy["Policy classifier"]
    Policy -->|"rejected"| Reject["Reject + audit"]
    Policy -->|"allowed"| Redact["Redaction / anonymization"]
    Redact --> Router["Provider router"]
    Router --> OpenAI["OpenAI provider"]
    Router --> Codex["Codex provider"]
    Router --> Local["Local LLM provider"]
    Router --> Mock["Mock provider"]
    OpenAI --> Structured["Structured draft"]
    Codex --> Structured
    Local --> Structured
    Mock --> Structured
    Structured --> Schema["JSON Schema validation"]
    Schema --> Guardrails["Safety validation"]
    Guardrails --> Review["Human review"]
    Review --> Accept["Accept scenario"]
    Review --> Reject2["Reject draft"]
```

## Výchozí governance

Externí AI provider je konfigurovatelný a lze ho vypnout. Každý AI návrh musí být auditovaný, validovaný proti JSON Schema a potvrzený člověkem před uložením jako spustitelný scénář.
