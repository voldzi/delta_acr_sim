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

Po zavedení samostatně přijatého `sim_driver_guard_source` se původní
provisioning/recovery nesmí použít k návratu širokých DML práv. Skript při
existenci tohoto namespace odmítá `--apply` a `--recover` ještě před změnou
grantů nebo zápisem nových přístupů. `--check` místo toho čte pevný
`guarded-runtime-verification.sql`: sedm SELECT, tři intake INSERT, UPDATE
jen `receipts.receipt`, bez přímého DELETE či zápisu erasure ledgeru/fences.
Jde pouze o diagnostiku práv, nikoli oprávnění mazat, Root readiness nebo
ověření obnovy. Guarded migrace se tímto skriptem automaticky neaplikuje.
Verifier má pevný katalogový search path a odmítá i zděděné PUBLIC column
INSERT/REFERENCES na chráněných tabulkách. Izolované ověření přechodu a
souběhu operací popisuje [záznam z 15. 10.](../archive/2026-10-15_DRIVER_GUARDED_OPERATIONS_SQL.md).

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

Receipt a dočasný revocation tombstone expirují za 7 dní. Expirace je
filtrována při čtení. Permanentní erasure fence a erasure ledger do této
retence nepatří. Původní zdroj používá minutový úklid a doplňkový cron po
15 minutách; erasure zdrojová větev jej nahrazuje chráněným životním cyklem.
Nasazený obraz ani jeho cron se touto zdrojovou změnou nemění.

V erasure kandidátu konstruktor neprovádí SQL a nezakládá časovač. Composition
spustí retenční úklid až po skutečném init a přijetí owner-maintenance
consumeru; jeho výchozí produkční vazba zatím chybí. Samostatný entrypoint
`scripts/driver-measurements-maintenance.mjs` používá stejnou bránu a při
nepřipojené autoritě skončí s chybou ještě před vytvořením DB poolu. Žádné
parametry CLI, env flag nebo přímé SQL nejsou náhradou. Tento kandidát se
do té doby nesmí nasadit, ani pouze s vypnutým příjmem.

Po přijetí skutečného consumeru se oba retenční DELETE provedou v jedné
transakci pod stejným neměnným cutoff. Časovač se nepřekrývá s vlastní
rozpracovanou prací a zavření čeká na SQL callback před uzavřením poolu.
Samotné dokončení promise consumeru není potvrzení dokončeného úklidu.
Ověření retence v revocation-only i plánovaného entrypointu patří do
[společné akceptace v runbooku 19](19_COP_ACCOUNT_ERASURE_PRODUCTION.md).

Expiration SQL kandidát pod `scripts/fixtures/driver-retention-real-schema/`
není instalační migrací a neprovádí se na produkci. Testuje původní transakci
nad skutečným schématem, včetně cascade a zachování trvalých erasure řádků.
Budoucí omezení grantů se musí nasadit zároveň s chráněnými náhradami revoke
a erase i s úpravou provisioning/recovery skriptu; samotné odebrání DELETE
by oba dnešní legitimní endpointy poškodilo. UPDATE se také nesmí ponechat
na expiry a identitních sloupcích. Podrobná source hranice je v
[integraci 23](../integration/23_SIM_ACCOUNT_SAFETY_RUNTIME_PREPARATION.md#pevný-databázový-původ-expirace).

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

Návrat vypíná sběr, nikoli revocation. Retenční úklid musí zachovat přijatou
ochrannou bránu; nejde o povolení vrátit přímý SQL obchvat. Zachovat DB,
síť a stejná HMAC.
Preferovat poslední obraz podporující revocation-only. Nouzový návrat na starý
provider obraz před touto funkcí ponechá COP deletion pending a nezávislý
retenční cron; nesmí se hlásit úspěšné smazání, dokud jej SIM nepotvrdí.
Nikdy neobnovovat starou DB jako rollback.
