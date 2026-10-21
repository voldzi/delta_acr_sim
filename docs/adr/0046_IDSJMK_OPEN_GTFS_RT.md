# ADR 0046: IDS JMK official open GTFS-RT

Status: accepted for implementation; production activation requires verified image and runtime acceptance.

Use https://kordis-jmk.cz/gtfs/gtfsReal.dat (official CC BY 4.0 open data), not the map application's private dispatcher endpoint. Attribution: KORDIS JMK, a.s. / IDS JMK; otevřená data GTFS-RT; zpracování CSM SIM. Source and licence information: https://www.idsjmk.cz/a/kontakty.html.

One shared in-process producer serves map queries and vehicle details. Minimum refresh is 30 seconds, concurrent loads coalesce, response size is limited to 8 MiB, timeout is bounded and failures use exponential backoff up to 15 minutes with Retry-After respected. No client-side provider access. The deployment is single-instance; adding replicas requires coordinated shared producer/rate limiting first. Cache is memory-only; no disk writes or historical archive is added.

Only full snapshots are accepted. Each position requires valid coordinates and its own actual vehicle observation timestamp. Missing timestamps are not replaced by header or fetch time. Positions or source snapshots older than 120 seconds are stale, not live. Re-evaluate freshness on cached API responses. Alerts are not vehicle positions. Unknown vehicle mode remains unknown without a verified static route association.

Keep the existing idsjmk_vehicle_positions identity, feature/detail contracts and server-side authentication. Production change is limited to the situation-data image and authoritative URL/cache overrides. Preserve all account-erasure, routing and other service settings. Rollback restores the exact prior pin configuration and image and verifies health. Acceptance requires real positions, observation ages, changing positions across two snapshots and shared-cache request counts, not health alone.
