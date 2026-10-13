# 17. Měření Jízdy: produkce, retence a návrat

## Rozsah a ochrana dat

Základ je publikovaná revize `e791afb`; hardening před nasazením HMACuje také
interní UUID dávky/ETA, klíče intervalů a digest požadavku. REST
`sim-driver-measurements-v1` se nemění: odpověď vrací původní UUID, DB jej neukládá.
Jde o pseudonymizaci, nikoli anonymizaci. HTTP tracing této konkrétní cesty je
vypnutý, aby neexportoval klientská ID, IP ani query string. Raw GPS je jen v RAM
a Valhalla POST map_snap, ne v DB, cache nebo logu SIM. Souhrny vždy `shadow_only`.

Rozšíření podle [ADR 0038](../adr/0038_DRIVER_MEASUREMENT_EVALUATION_AND_COMPARISON.md)
je připravené pouze ve zdrojovém kódu: chráněná evaluace, operátorský přehled
a oddělený porovnávací selector. Sdílené DB servisní okno je uzavřené, ale
produkční změna čeká na X5 preflight a společný release slot. Tento runbook není potvrzení aktuálního
nasazeného obrazu nebo přepnutí účtů COP. Význam v1 se nemění na živou dopravu.

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

## Dostupnost účtům a chráněná evaluace

COP má nabídnout dobrovolný sběr kterémukoli autentizovanému účtu, nikoli
jen seznamu pilotů. Před každou dávkou ověřuje skutečný souhlas a správnou
identitu; klient neurčuje cizí pseudonym. Tato dostupnost nesmí automaticky
udělit souhlas, zvýšit limity nebo obejít frontu a její backoff. SIM nadále
přijímá pouze vyhrazenou službu COP, nikoli lidský účet nebo mobil přímo.

Nová interní cesta:
`http://sim-driver-measurements:4020/api/v1/internal/driver-measurements/v1/evaluation`.
Používá stejný službový token jako `/quality`, `Cache-Control:no-store`,
odmítnutí browser `Origin` a neznámých query parametrů. Vypnutý příjem
vrací 503 také pro evaluaci; zachované mazání není povolení k novému čtení.
Databázové čtení běží v jedné transakci `READ ONLY REPEATABLE READ`, bez
DDL, nových tabulek nebo změny retence.

Počty dávek, duplicit a osm povolených rejection codes jsou za retained
sedmidenní data. Rychlostní skupiny a klientské ETA jsou za posledních
24 hodin uložených bucket starts a s explicitním aktivním grafem.
`generatedAt = asOf = evaluationWindow.until`; fresh report nenahrazuje
skutečný čas pozorování. Future count znamená budoucí pětiminutový bucket,
nikoli všechny budoucí GPS body ve stejném bucketu. Konec aktuálního okna
je `floor(asOf / 5 min) × 5 min + 5 min`, nikdy nový uploadový TTL.
Quality count pouze splnil 5 přispěvatelů / 10 intervalů; neprůkazná nezávislost
účtů, nepokrytá celá hrana a klientská ETA zůstávají výslovné omezení.

Výstup `sim-driver-evaluation-v1` neobsahuje GPS, UUID, contributor hashes,
pseudonymy, edge IDs ani jednotlivé jízdy. Prázdná ETA je `[]`, poslední příjem
bez dat `null`. Operátorská cesta SIM `/api/v1/operations/driver-measurements`
zůstává pod existujícím přihlášením a čte pouze typovaný scalar report,
nikoli partnerská nebo klientská raw data. Chybějící report je unavailable,
neplatný invalid a starší než 90 s stale; stale není current. Metriky se
nevkládají do veřejných vrstev ani AI promptů.

## Provoz odvozeného reportu

Volitelné `DRIVER_MEASUREMENTS_EVALUATION_REPORT_FILE` určuje writer cestu
končící přesně `latest.json`; `SIM_OPERATIONS_DRIVER_MEASUREMENT_REPORT_FILE`
určuje reader cestu k témuž reportu. Obě hodnoty patří pouze do schválené
serverové konfigurace. Report nemá službový token, DB URL ani HMAC tajemství.
Zdrojový publisher vytváří pouze jednu poslední kopii, obnovuje ji nejvýše
jednou souběžnou operací a běžně po 60 s. Reader nepřijímá symlinky, soubor
nad 64 KiB, neznámé klíče nebo neplatné časové a početní vztahy.

Případný hostitelský bind mount pro další schválené okno je
`/srv/x5-production/cache/csm-sim/driver-measurement-reports/`, uvnitř obou
služeb `/driver-measurement-reports/`. Jde jen o obnovitelný scalar report,
nikoli primární databázi nebo archiv jízd. Před jeho vytvořením ověřit samostatný
mount a UUID `2f93f595-b61b-4eea-9054-7afa9b275b5b`, dostatek místa,
vlastníka a práva. Writer má zapisovat pouze do této složky; reader má
read-only mount. Privátní `latest.json` má práva 600 a číst jej smějí pouze
dotčené služby se správnou provozní identitou. Zdroj nepřesouvá PostgreSQL,
secrets nebo existující data a nevyžaduje nový veřejný port či službový token.

Po potvrzeném databázovém DELETE publisher zahodí starý rozpracovaný pohled
a musí potvrdit nový report bez odvolaného příspěvku, případně report odstranit.
V režimu revokace při vypnutém příjmu jej pouze odstraní, bez volání matcheru.
Odpověď 200 vyžaduje dokončení této odvozené operace; při chybě je 503 a COP
ponechá pending deletion, i když SQL DELETE již proběhlo. Samotná 202 COP
potvrzuje pouze zařazení do fronty. Tato ochrana souboru není durable fence
pro live traffic writer ani potvrzení smazání fyzických záloh.

## Porovnávací příprava a další brány

`driver-speed-pilot.ts` je čistý selector bez IO, provider požadavků, cache
a writeru. Výchozí `disabled`, volitelné `comparison_only` pouze vyhodnocuje
revidované směrové hrany daného grafu, původní okno, práh 5/10, rychlostní
strop a rozptyl. Čerstvá oficiální rychlost má vždy přednost. Při neznámém
oficiálním pokrytí nelze předpokládat absenci oficiálního zdroje.
Runtime report této verze zůstává `comparisonMode:"disabled"`,
`livePromotionSupported:false`, `liveAppliedGroupCount:0`.

Pro živé doplňování je nutná nová etapa: účelově odpovídající souhlas,
spolehlivé skutečné stáří a průjezd hranou včetně dopravních zastavení,
kontrola nezávislosti přispěvatelů, autoritativní oficiální pokrytí, generační
ochrana revokace napříč procesy a potvrzení odstranění všech live kopií,
nezávislé vyhodnocení ETA a omezený canary s návratem. Starý souhlas
`traffic-quality-v1` ani čerstvé `generatedAt` tyto podmínky nenahrazují.

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

Dokud platí případný další HOLD, následující postup se nespouští. Před otevřením nového
okna je nutné sjednotit přesné revize SIM/COP/Jízdy, zkontrolovat a znovu
ověřit testy, závazné OpenAPI a publikované obrazy. Zdrojová příprava není
důkaz produkční, geografické nebo fyzické iPhone akceptace.
Neprovádět nové env zálohy, kopie, dočasné env soubory, přenos tokenů,
rotaci HMAC, změnu sítě nebo databáze jako vedlejší krok této evaluace.
Konfiguraci a případný bind mount lze měnit až v přesně schváleném okně.

Zachovat dirty otel/X5/secrets; fast-forward konkrétního SHA. Původní SDA obraz
označit rollback tagem. Stavět pouze SDA, OCI revision label a tag s plným SHA.
`docker compose up -d --no-deps situation-data-api` bez restartu Valhally,
Docker daemonu či jiných projektů. COP API recreate pouze pro secrets/cleanup.
Web bránu reloadovat po `nginx -t` pro blokování nové interní cesty.

Pro rozšíření evaluace je plánované nasazení omezené na přesně tři služby:
`situation-data-api`, `sim-api` a `sim-web`. Vyžaduje vlastní
schválené revize a identitu každého obrazu nad zkontrolovaným provozním základem,
nikoli rebuild celé vývojové větve. Zachovat routing hotfix, observability,
X5 a driver overlays i aktuální hodnoty secrets a flags; žádný reset dirty
checkoutu, restart dalších služeb, změna Valhally nebo globální Docker operace.
COP přepnutí účtů a akceptace na iPhonu jsou oddělené koordinované kroky.
Opt-in overlay `docker-compose.driver-measurement-evaluation.yml` vyžaduje
`SIM_DRIVER_EVALUATION_HOST_DIR` s přesnou výše uvedenou cache cestou; nepřipojuje
celý X5 ani širší operational-checks adresář. Před každou schválenou změnou
spustit `scripts/preflight-driver-evaluation-x5.sh`. Je read-only a skončí při
jiném UUID, zařízení, cestě, právech nebo nedostatku místa bez změny.

Návrat vypíná sběr, nikoli revocation/cleanup. Zachovat DB, síť a stejná HMAC.
Preferovat poslední obraz podporující revocation-only. Nouzový návrat na starý
provider obraz před touto funkcí ponechá COP deletion pending a nezávislý
retenční cron; nesmí se hlásit úspěšné smazání, dokud jej SIM nepotvrdí.
Nikdy neobnovovat starou DB jako rollback.

Při návratu evaluace nejprve zastavit publikaci, odstranit jen scalar
`latest.json` a ověřit, že UI ukazuje unavailable/stale místo starého current
stavu. Sběr lze vypnout nezávisle, ale režim revokace, její fronta a retenční
úklid musí zůstat funkční. Nevracet staré kopie reportu či databáze.
Oficiální traffic updater, uzávěry a běžné trasy tato změna nepřepíná.
