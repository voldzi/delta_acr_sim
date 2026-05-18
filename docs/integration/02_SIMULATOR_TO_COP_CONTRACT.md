# Simulator to COP contract

**Status:** Baseline dokumentace

## Směr komunikace

SIM komunikuje s COP jednosměrně jako publisher syntetických eventů. COP může odpovídat stavem příjmu, chybou, rate limitem nebo revokací zdroje.

## Endpointy

- `POST {MAIN_COP_BASE_URL}/api/v1/ingest/events` pro jednotlivé eventy.
- `POST {MAIN_COP_BASE_URL}/api/v1/ingest/batches` pro dávky.

## Kontraktační payload

Payload musí odpovídat `canonical-event-envelope.schema.json`. Batch je kolekce těchto envelope objektů s batch metadaty a idempotency semantikou.

## Nezávislost

SIM nesmí vyžadovat žádný interní COP typ, databázi ani service discovery. Vše potřebné je konfigurované přes base URL, auth a contract version.
