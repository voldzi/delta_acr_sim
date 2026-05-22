# Glosář

**Status:** Baseline dokumentace

## Termíny

- **SIM**: samostatný simulační systém a datový provider.
- **COM**: centrální zobrazovací aplikace používající source-neutral mapový katalog a map query.
- **COP**: aktuální implementace COM/Common Operational Picture; není součástí tohoto repozitáře.
- **Shared Integration Contract v1**: kontrakt pro publikaci syntetických eventů ze SIM do aktuálního COM/COP ingestu.
- **Provider Map Catalog**: source-neutral katalog mapových vrstev a zdrojů publikovaný providerem pro COM backend.
- **Canonical Event Envelope**: jednotný obal eventu s metadaty zdroje, klasifikací, kvalitou a payloadem.
- **Publisher**: komponenta SIM systému odpovědná za validaci, frontu, retry a odesílání eventů.
- **Dry-run**: režim, kdy se eventy generují a validují, ale neodesílají do reálného COM/COP endpointu.
- **Mock COP endpoint**: testovací endpoint simulující očekávané odpovědi COP ingest API.
- **AI Scenario Assistant**: UI a backend workflow pro návrhy syntetických scénářů s guardrails a human review.
- **Fault injection**: řízené zavádění zpoždění, duplicit, výpadků, degradované přesnosti a replay chování pro testování odolnosti.
- **Synthetic data marking**: povinné označení každé události jako syntetické v classification handling caveats i simulation metadatech.

## Event typy

`track.created`, `track.updated`, `track.lost`, `track.restored`, `track.deleted`, `incident.created`, `incident.updated`, `report.created`, `source.status.changed`.

## Role

`SIM_ADMIN`, `SIM_OPERATOR`, `SIM_VIEWER`, `SIM_AI_USER`, `SIM_AI_ADMIN`.
