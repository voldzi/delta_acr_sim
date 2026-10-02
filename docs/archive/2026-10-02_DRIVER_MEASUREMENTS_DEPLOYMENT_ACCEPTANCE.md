# Měření Jízdy — nasazení a kontrolní důkazy 2. 10. 2026

## Nasazený runtime

- Host `docker.home.cz`, pouze situation-data-api, úzká konfigurace webové brány
  a COP API pro nové secrets/cleanup. Ostatní kontejnery nebyly restartovány.
- Výchozí větev `codex/driver-measurements-integration`, původní `e791afb`.
- Nasazená aplikační revize `b3e94c9b02e480268fd8b51c284069602b9fa2c1`.
- Obraz `sim-situation-data-api:driver-b3e94c9b02e480268fd8b51c284069602b9fa2c1`.
- Image ID `sha256:00b842865ef8d31610a57e69fcfd34c65a9a8f31c9b9731a73c16c5ea0a7f882`;
  OCI revision odpovídá revizi výše. Následující dokumentační/restore-guard commit
  mění jen provozní artefakty, nikoli sestavený aplikační kód.
- SDA healthy, live/ready 200. COP healthy, live/ready/dependencies 200.
- SDA HostConfig.PortBindings `{}`. Síť `cop_sim_driver_measurements_internal`
  je Internal=true, připojené pouze SDA a COP API.
- Oba Compose labely obsahují vlastní `docker-compose.driver-measurements.yml`.
- Interní root: `http://sim-driver-measurements:4020/api/v1/internal/driver-measurements/v1`.
- Webová cesta `/situation-data/api/v1/internal/driver-measurements/v1/quality`
  vrací 404; tato cesta má access_log off a nebufferuje GPS požadavky.

## Příznaky, DB a secrets

SIM intake=false, revocation=true, rate=120/min. COP intake=false, cleanup=true.
`sim-driver-measurements-v1`, výhradně shadow_only; žádný live traffic/ETA writer.
Dedikovaný token a SIM HMAC vytvořené jen na hostu v mode-600 secrets;
COP HMAC zachován a fingerprint v COP DB potvrzen vlastníkem COP.
Migrační přístup nebyl přenesen do runtime ani logu.

Operátor zřídil DB `sim_driver_measurements` přes `haproxy.home.cz:5000`.
Živý runtime `driver_measurements_runtime`: superuser/createdb/createrole/
replication/bypassrls/schema CREATE/database CREATE vše false; DML na čtyřech
tabulkách ověřeno. Žádná skutečná data: receipt=0, interval=0, ETA=0;
jediný HMAC tombstone patří syntetickému testu smazání a expiruje za 7 dní.
Minute cleanup v API + nezávislý user cron každých 15 minut; jednorázové spuštění
nezávislého cleanupu dvakrát prošlo s nulou expirovaných záznamů.

## Testy a odlišení důkazů

| Kontrola | Výsledek / prostředí |
| --- | --- |
| Bez bearer | 401, skutečné COP API → SIM |
| Neplatné DELETE | 400, skutečné COP API → SIM |
| Vypnutý batch / agregace | 503, skutečné COP API → SIM |
| Syntetické DELETE | 200, skutečné COP API → SIM, bez uživatelského souhlasu/GPS |
| Service budget | 429, skutečné COP API → SIM; invalid požadavky bez DB writes |
| Idempotence / conflict / ETA dedupe | izolované PostgreSQL + HTTP testy |
| Stáří / kvalita / směr / graf / spoofing input | syntetické validační a matcher testy |
| Pět přispěvatelů / deset intervalů / oversampling | izolovaná skutečná PostgreSQL, rovné váhy |
| Souběžná dávka + revoke | po smazání bez příspěvku v agregaci; další commit 403 |
| HMAC UUID / žádné raw GPS a původní ID v tabulkách | SQL serializace všech tří datových tabulek v izolované DB |
| Chyba DB / matcher | HTTP fault testy 503 bez detailů požadavku |
| Skutečné selhání PostgreSQL socketu | oddělený runtime test: DELETE 503, unrelated health 200 |
| Retence / FK cascade / no-DDL | izolované PostgreSQL testy |
| Obnova v karanténě | správná testovací DB purge; jiná DB exit 3 před TRUNCATE |
| Log privacy | syntetické marker ID / invalid body nejsou v logu produkčního SIM |
| Valhalla runtime kompatibilita | syntetická geometrie, 5 matched bodů, 4 forward same-edge páry |

Aktuální ověřený graf `sim-routing-2026-09-29-1790679143`; matcher kontroluje
dataset před i po map_snap. Jednorázová geometrie byla generována z trasy,
nikoli získaná ze skutečné jízdy. Není to přijetí přesnosti GPS, vozovky nebo ETA.

SIM regresní sada: 335 prošlých testů, šest DB testů ve standardním běhu přeskočeno;
samostatně SDA s explicitní dočasnou PostgreSQL: 198/198, včetně všech šesti DB
testů (tedy celkem 341 unikátních runtime testů napříč službami).
Typecheck, build, skeleton, OpenAPI validation: prošly. Chroma reindex nešel,
server Chroma nebyl dostupný. Dočasná DB neměla volume a po ověření byla odstraněna.

## Zbývající brány

1. Mobilní OIDC/consent/outbox/revoke společně s COP a skutečným iPhonem;
   COP 202 je pending, nikdy potvrzené smazání. Skutečný příjem zůstává vypnutý.
2. Správce fyzických PostgreSQL/PBS/WAL záloh musí potvrdit šifrování, přístup
   a retenci. Aplikace nezměnila clusterový backup plán a nemůže potvrdit fyzické
   odstranění starých stránek; obnovovací karanténa brání návratu do agregací.
3. Rozsáhlé load testy a nezávislý geografický audit vozovek před širším sběrem.
4. Jakékoli využití pro živé rychlosti/ETA vyžaduje další samostatnou etapu.

Původní SDA obraz zůstal pod `sim-situation-data-api:before-driver-20261002`.
Návrat preferuje aktuální revocation-only režim; starý obraz nepodporuje mazání,
proto se nesmí zahodit cleanup/fronta nebo obnovit starší DB. Viz runbook 17.
