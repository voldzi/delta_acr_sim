# Publisher testing

**Status:** Baseline dokumentace

## Scénáře

- valid single event
- valid batch
- schema validation failure
- missing SYNTHETIC marker
- 401/403 stop publishing
- 429 Retry-After
- 503 retry/backoff
- idempotency retry
- restart with persistent queue
- dead-letter queue

## Očekávání

Publisher nesmí ztratit queued event při krátkém výpadku a nesmí odeslat event bez validace.
