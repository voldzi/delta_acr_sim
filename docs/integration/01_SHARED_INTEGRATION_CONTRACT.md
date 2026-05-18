# Shared Integration Contract v1

**Status:** Baseline dokumentace

Shared Integration Contract v1 je závazná integrační hranice mezi SIM systémem a samostatně vyvíjeným COP systémem. SIM musí být testovatelný bez existujícího COP prostředí, proto podporuje dry-run a mock COP endpoint.

## Odpovědnosti SIM systému

- Generovat výhradně syntetická data.
- Validovat každý event proti `canonical-event-envelope.schema.json`.
- Doplnit `sourceSystemId`, `adapterVersion`, `eventId`, `correlationId`, idempotency key a `producerTimestamp`.
- Označit každý event jako `SYNTHETIC` v klasifikaci i `simulation.synthetic`.
- Udržovat persistent publisher queue, retry/backoff a dead-letter queue.
- Podporovat dry-run a mock režim bez živého COP endpointu.
- Logovat publisher odpovědi, latenci a chybové stavy.

## Odpovědnosti COP systému

- Přijmout eventy podle kontraktu `cop-ingest-v1`.
- Ověřit autentizaci, autorizaci a revokaci zdroje.
- Validovat idempotency a schema kompatibilitu.
- Doplnit `ingestTimestamp`/`receivedAt`, `ingestId` a `correlationId` v odpovědi.
- Vrátit standardizované chyby pro validaci, auth, rate limit a interní selhání.
- Nevyžadovat, aby SIM znal interní canonical fusion nebo COP state model.

## Hranice mezi projekty

SIM publikuje do COP přes HTTP API. COP interní model, fusion, distribuce a rendering nejsou součástí SIM. SIM nesmí předpokládat běžící COP; všechny integrační toky musí mít dry-run nebo mock variantu.

## Verze kontraktu

- Název verze: `Shared Integration Contract v1`.
- Header kontraktu: `X-Contract-Version: cop-ingest-v1`.
- Breaking change vyžaduje novou verzi, ADR a paralelní podporu staré verze po dohodnutou dobu.
- Non-breaking change může přidat volitelná pole, pokud neporuší validaci starých klientů.

## Endpointy COP ingest

```http
POST {MAIN_COP_BASE_URL}/api/v1/ingest/events
POST {MAIN_COP_BASE_URL}/api/v1/ingest/batches
```

## Autentizace

Minimální baseline počítá s bearer tokenem. Kontrakt připouští mTLS nebo OIDC client credentials podle prostředí. Secrets se konfigurují mimo repozitář.

```http
Authorization: Bearer <token>
X-Source-System-Id: sim-air-situation-001
X-Idempotency-Key: <uuid>
X-Contract-Version: cop-ingest-v1
X-Correlation-Id: <uuid>
```

## Povinná metadata

- `sourceSystemId`: stabilní identita SIM instance.
- `adapterVersion`: verze SIM publisher adapteru.
- `eventId`: globálně unikátní ID eventu.
- `correlationId`: ID pro trasování požadavku napříč SIM a COP.
- `producerTimestamp`: čas vzniku eventu v SIM.
- `ingestTimestamp` nebo `receivedAt`: čas přijetí na straně COP.
- `classification`: klasifikace dat včetně handling caveat `SYNTHETIC`.
- `simulation.synthetic`: musí být `true`.

## Idempotency

SIM generuje idempotency key pro každý event nebo batch item. Opakované doručení stejného eventu musí být bezpečné. COP může vrátit `200`, `202` nebo `409` podle své politiky duplicit; SIM musí výsledek auditovat a nesmí vytvářet nový eventId pro retry stejné události.

## Povolené event typy

- `track.created`
- `track.updated`
- `track.lost`
- `track.restored`
- `track.deleted`
- `incident.created`
- `incident.updated`
- `report.created`
- `source.status.changed`

## Error model

Standardní chybová odpověď:

```json
{
  "error": {
    "code": "VALIDATION_ERROR|UNAUTHORIZED|FORBIDDEN|RATE_LIMITED|SOURCE_REVOKED|INTERNAL_ERROR",
    "message": "Payload does not match schema.",
    "details": [],
    "correlationId": "uuid"
  }
}
```

## Retry a backoff

- Retry pro síťové chyby, `429`, `500`, `502`, `503`, `504`.
- Bez retry pro `400`, `401`, `403`, `422`, pokud konfigurace neurčí ruční zásah.
- Exponential backoff s jitterem a maximálním počtem pokusů.
- Dead-letter queue pro nevratně selhané eventy.
- `Retry-After` má přednost před lokálním výpočtem backoff.

## Schema validation

SIM validuje před enqueue i před odesláním. COP validuje při příjmu. Referenční schema je [canonical-event-envelope.schema.json](../api/schemas/canonical-event-envelope.schema.json).

## Breaking changes policy

Breaking change je změna, která odstraní pole, změní význam pole, zpřísní validaci stávajícího payloadu, změní autentizační pravidla nebo změní idempotency semantiku. Taková změna vyžaduje novou verzi kontraktu a ADR.
