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
- Uživatelský projektový OpenAI klíč COP vstupuje jen přes interní COP API,
  v Routeru se šifruje AES-256-GCM s klíčem mimo databázi a nikdy se
  nevrací. Správa klíče je vázána na krátce platný HMAC podepsaný `sub`
  uživatele; COP nesmí klíč logovat. Odebírání v Routeru neodvolává klíč u
  poskytovatele a staré zálohy mají vlastní retenční pravidla.
- `AI_ROUTER_COP_ACTOR_SECRET`, `AI_ROUTER_CREDENTIAL_ENCRYPTION_KEY` a
  `AI_ROUTER_IZS_TOKEN` jsou vzájemně oddělené tajné hodnoty. Šifrovací
  klíč nesmí zaniknout, dokud existují zašifrované uživatelské klíče;
  změna vyžaduje přešifrování, ne pouhé přepsání proměnné.
- Připravovaná account-safety autorita drží podpisový klíč, omezené
  PostgreSQL control profily a schválené identity/klíčové historie pouze
  v chráněné Root instalaci. App kontejner nesmí dostat tyto soubory,
  control credentials, signer nebo celý privátní run adresář; jen konkrétní
  socket a veřejný ověřovací bootstrap. Veřejný keyring není oprávnění.
- Historie denních HMAC klíčů musí mít doložené meze skutečného vydávání;
  datum prvního příjmu ani prázdná databáze je nenahrazují. Pseudonymy,
  principál i spojení kandidátů s dny zůstávají při Root ověření pouze
  v RAM, bez logu nebo trvalého denního joinu. Chybějící klíčová verze
  znamená HOLD. Mazání z SQL neruší existenci tajemství či dat v zálohách.
- Připravené soukromé profily používají přesný fixovaný formát a ověřenou
  TLS CA/server name; nelze vybírat credential, DSN, profil nebo SQL z HTTP.
  Produkční vytvoření a předání souborů je oddělený omezený instalační
  krok, nikoli součást source testu nebo automatická adopce z `.env`.
- Podepsaná historie owner politik zůstává oddělená v Root-only 0700
  `/var/lib/cop-account-safety/owner-policy-history`. Obsahuje přesné
  původní bajty politik, nikoli principály, daily joiny nebo nové kopie
  přístupových klíčů. Neměnný archiv se zapisuje před prvním checkpoint
  intentem/setterem a nikdy se při chybě neskládá z cílové DB. App jej
  nedostává přes bind mount; obnova archivu sama neuděluje oprávnění.

## Konfigurační typy

- COP bearer token nebo client credentials.
- Per-backend `GEO_ROUTING_SERVICE_TOKENS`; provision and rotate each actor
  independently and never place a real value in `.env.example` or OpenAPI.
- mTLS certifikáty, pokud budou použity.
- OpenAI/API provider credentials.
- Lokální LLM runtime konfigurace bez tajných hodnot, pokud možno.
