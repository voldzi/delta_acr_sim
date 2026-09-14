# Secret management

**Status:** Baseline dokumentace

## Pravidla

- Žádné secrets v repozitáři.
- Secrets se načítají přes environment nebo secret store.
- Logy a audity ukládají pouze reference nebo hash, nikdy hodnotu secretu.
- Rotace tokenu nesmí vyžadovat změnu kódu.
- `TPEG2_API_TOKEN` je upstream serverový credential: smí být pouze v chráněném
  produkčním prostředí situation-data-api. Nesmí se objevit v katalogu,
  normalizovaných features, URL logu, chybové odpovědi ani v raw projekci.
- `VALHALLA_TRAFFIC_CONTROL_TOKEN` je samostatný opaque bearer pouze pro
  normalizovaný SIM–Valhalla traffic kanál. Na `docker.home.cz` zůstává v
  root/user-only `.env`, na `valhalla.home.cz` v root-only
  `/srv/valhalla/.traffic.env`. Nesmí se odvozovat z TPEG2 tokenu ani objevit v
  argumentech procesu, logu nebo API odpovědi.
- Externí AI API klíče lze vypnout odstraněním konfigurace.

## Konfigurační typy

- COP bearer token nebo client credentials.
- Per-backend `GEO_ROUTING_SERVICE_TOKENS`; provision and rotate each actor
  independently and never place a real value in `.env.example` or OpenAPI.
- mTLS certifikáty, pokud budou použity.
- OpenAI/API provider credentials.
- Lokální LLM runtime konfigurace bez tajných hodnot, pokud možno.
