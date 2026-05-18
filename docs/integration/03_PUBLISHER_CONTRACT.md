# Publisher contract

**Status:** Baseline dokumentace

Publisher contract definuje chování SIM komponenty, která posílá syntetická data do hlavní COP aplikace.

## Cílové COP endpointy

```http
POST {MAIN_COP_BASE_URL}/api/v1/ingest/events
POST {MAIN_COP_BASE_URL}/api/v1/ingest/batches
```

## API konfigurace

- `mainCopBaseUrl`: base URL cílového COP prostředí.
- `contractVersion`: výchozí `cop-ingest-v1`.
- `sourceSystemId`: stabilní identifikátor SIM instance.
- `adapterId`: výchozí `simulation-adapter`.
- `adapterVersion`: semver verze publisher adapteru.
- `defaultClassification`: výchozí klasifikace syntetických dat.
- `dryRun`: pokud `true`, eventy se neodesílají do COP.
- `mockMode`: pokud `true`, eventy jdou na mock endpoint.
- `batchSize`, `maxRetries`, `backoff`, `rateLimit`.

## Autentizace

Publisher podporuje baseline bearer token a návrhově i mTLS/OIDC client credentials. Secrets se načítají z prostředí nebo secret store, nikdy z repozitáře.

## Idempotency

- Každý event má stabilní `eventId` a idempotency key.
- Retry stejného eventu nesmí vytvořit nový `eventId`.
- Batch itemy musí být idempotentní samostatně.
- Odpovědi COP s duplicitou se auditují a neberou se automaticky jako ztráta dat.

## Retry/backoff

Publisher používá exponential backoff s jitterem, respektuje `Retry-After` a rozlišuje retryable a non-retryable chyby. Po vyčerpání pokusů přesune event do dead-letter queue.

## Persistent queue

Queue je durable mezi restarty aplikace. Každý záznam obsahuje payload hash, stav, počet pokusů, poslední chybu, plán dalšího pokusu, correlationId a auditní metadata.

## Dead-letter queue

DLQ uchovává eventy, které nelze doručit automaticky. Operátor může zobrazit redigovaný payload, chybu, provést retry po opravě konfigurace nebo exportovat diagnostiku.

## Dry-run

V dry-run režimu publisher provede envelope build, schema validation, synthetic marking check a queue/audit zápis, ale nevolá COP endpoint. Výsledek se označí jako `DRY_RUN_VALIDATED` nebo `DRY_RUN_REJECTED`.

## Mock mode

Mock mode směruje volání na lokální mock COP endpoint. Slouží pro contract testy, retry testy a demo bez COP.

## Batch sending

Batch sending seskupuje validní eventy podle konfigurace. Batch nesmí míchat různé contract versions ani sourceSystemId.

## Error handling

- `400/422`: validace, přesun do DLQ nebo ruční zásah.
- `401/403`: auth problém, zastavit publikaci a auditovat.
- `409`: idempotency konflikt, vyhodnotit payload hash a auditovat.
- `429`: respektovat `Retry-After`.
- `5xx` a síťové chyby: retry/backoff.

## Observability

Publisher vystavuje queue size, DLQ size, published events/s, failed events/s, retry count, ingest latency, last success, last failure a current mode.

## Okamžité zastavení publikace

Stop publishing přepne live odesílání do zastaveného režimu. Nezastaví runtime generování, pokud operátor nezastaví scénář samostatně. Queue zůstává zachovaná.
