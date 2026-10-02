# 17. Měření Jízdy: produkce, retence a návrat

## Rozsah a ochrana dat

Základ je publikovaná revize `e791afb`; hardening před nasazením HMACuje také
interní UUID dávky/ETA, klíče intervalů a digest požadavku. REST
`sim-driver-measurements-v1` se nemění: odpověď vrací původní UUID, DB jej neukládá.
Jde o pseudonymizaci, nikoli anonymizaci. HTTP tracing této konkrétní cesty je
vypnutý, aby neexportoval klientská ID, IP ani query string. Raw GPS je jen v RAM
a Valhalla POST map_snap, ne v DB, cache nebo logu SIM. Souhrny vždy `shadow_only`.

## DB a secrets

Operátor použije `provision-driver-measurements-postgres.sh --apply`, skryté
heslo `PGUSER=postgres`. HAProxy `haproxy.home.cz:5000`, DB
`sim_driver_measurements`; owner `driver_measurements_migrator`, runtime
`driver_measurements_runtime` má CONNECT, USAGE a DML na čtyřech tabulkách,
bez DDL nebo privilegovaných rolí. Migrace je opakovatelná.
Migrační URL zůstává administrátorovi. Pouze runtime URL se bezpečně přenese
na stdin `configure-driver-measurements-production.mjs <reviewed SHA>` na hostu.
Skript mění pouze jmenované klíče v mode-600 `/srv/sim/.env`, `/srv/cop/.env`.
Dedikovaný token a SIM HMAC generuje přímo tam; existující COP HMAC zachová.
Nikdy nevypisovat env, `docker inspect` env nebo celou rozbalenou Compose konfiguraci.
Secret backup je mode 600. HMAC nelze rotovat před vymazáním dat a COP fronty.

## Síť a počáteční příznaky

`cop_sim_driver_measurements_internal` musí mít `Internal=true`; pouze COP API
a situation-data-api. SIM autoritativní opt-in overlay
`docker-compose.driver-measurements.yml` je v `COMPOSE_FILE` spolu s původními
default/X5 soubory. COP má vlastní overlay. Žádný nový veřejný port.
Webová brána pro `/situation-data/api/v1/internal/driver-measurements/` vrací 404,
bez access logu. Mobil používá pouze autentizované COP API.

Společný interní endpoint z COP API:
`http://sim-driver-measurements:4020/api/v1/internal/driver-measurements/v1`.

- SIM `DRIVER_MEASUREMENTS_ENABLED=false`, `DRIVER_MEASUREMENTS_REVOCATION_ENABLED=true`.
- COP `COP_DRIVER_MEASUREMENTS_ENABLED=false`, `COP_DRIVER_MEASUREMENTS_CLEANUP_ENABLED=true`.
- S tokenem příjem/čtení 503; DELETE funguje. Bez tokenu 401, invalid DELETE 400,
  překročení limitu 429/Retry-After, výpadek DB 503 bez falešného úspěchu.
- COP 202 znamená čekající smazání, nikoli dokončení; chyba SIM frontu zachová.

Plná funkcionalita se ověřuje synteticky v izolované DB, nikoli krátkým zapnutím
produkčního sběru. Testovat idempotenci, privacy, stáří/quality, směr/graf,
rovné váhy přispěvatelů, retenci, FK cascade a souběh commit/revoke.
Geografická jistota paralelních vozovek a reálný iPhone jsou další společnou bránou.

## Sedm dní, úklid a zálohy

Receipt a revocation tombstone expirují za 7 dní. Expirace je filtrována při
čtení; cleanup každých 60 s maže receipt a FK cascade intervaly/ETA.
Běží i v revocation-only. Doplňkový user cron po 15 minutách spouští
`scripts/cleanup-driver-measurements-production.sh` v krátkodobém SDA obrazu
s runtime účtem i při zastaveném SDA. Nezasahuje do jiných DB.

Nezavádět dlouhodobé logical exporty těchto krátkodobých odvozených dat.
Existující fyzické PBS/WAL/PITR zálohy clusteru tato aplikace nemění; mohou
obsahovat starší stránky. SQL DELETE nezaručuje odstranění z fyzických záloh.
Správce musí potvrdit jejich šifrování, oprávnění a retenční dobu. Bez potvrzení
se nesmí tvrdit „smazáno ze všech záloh“.
Každá obnova probíhá s odpojeným měřením. Před znovupřipojením je povinný
`deploy/driver-measurements/restore-quarantine.sql` na této jediné DB: vymaže
všechny obnovené příspěvky/tombstones. COP deletion queue nesmí být obnovena
do staršího stavu. Obnovená data se nikdy nezpřístupní agregaci.

## Nasazení a rollback

Zachovat dirty otel/X5/secrets; fast-forward konkrétního SHA. Původní SDA obraz
označit rollback tagem. Stavět pouze SDA, OCI revision label a tag s plným SHA.
`docker compose up -d --no-deps situation-data-api` bez restartu Valhally,
Docker daemonu či jiných projektů. COP API recreate pouze pro secrets/cleanup.
Web bránu reloadovat po `nginx -t` pro blokování nové interní cesty.

Návrat vypíná sběr, nikoli revocation/cleanup. Zachovat DB, síť a stejná HMAC.
Preferovat poslední obraz podporující revocation-only. Nouzový návrat na starý
provider obraz před touto funkcí ponechá COP deletion pending a nezávislý
retenční cron; nesmí se hlásit úspěšné smazání, dokud jej SIM nepotvrdí.
Nikdy neobnovovat starou DB jako rollback.
