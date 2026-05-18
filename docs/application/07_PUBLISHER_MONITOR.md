# Publisher monitor

**Status:** Baseline dokumentace

## Zobrazení

- Poslední odeslané eventy a jejich status.
- COP odpovědi, HTTP statusy, correlationId a ingestId.
- Retry operace, backoff plán a dead-letter queue.
- Idempotency keys, batch IDs, rate limit informace a latence.
- Payload preview s rolově řízenou redakcí.

## Akce

- test connection
- send sample
- retry queue
- clear queue v dry-run/test režimu
- stop publishing immediately
