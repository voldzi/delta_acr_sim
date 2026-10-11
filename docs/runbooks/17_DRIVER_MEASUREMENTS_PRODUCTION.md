# 17. Jízda: produkční pilot, rotace přístupu a mazání

## Hranice

Kontrakt `sim-driver-measurements-v1` a režim `shadow_only` jsou neměnné.
Mobil volá autentizované COP API; SIM je dostupná jen službě COP na
`http://sim-driver-measurements:4020/api/v1/internal/driver-measurements/v1`.
Privátní Docker síť má právě COP API a situation-data-api, bez nového
veřejného portu. Interní cesta není zpřístupněna veřejným browserům.

Pilot schválený 11. 10. 2026 je omezený v COP na serverem ověřený OIDC subject.
COP `COP_DRIVER_MEASUREMENTS_PILOT_ENABLED=true` a chráněný
`COP_DRIVER_MEASUREMENTS_PILOT_SUBJECT_IDS` omezují nové souhlasy a dávky.
Seznam je serverová konfigurace, nikoli údaj předaný telefonem. Nepilotní
účet nezíská příjem. Dosavadní DELETE/cleanup funguje i mimo pilot.

## Rotace službového tokenu

1. Nejprve obě intake flags `false`; SIM revocation-only a COP cleanup `true`.
2. Ověřit X5 UUID `2f93f595-b61b-4eea-9054-7afa9b275b5b`, health, přesné
   obrazy, privátní síť, autoritativní Compose overlays a mode-600 env.
3. Pod COP storage lockem provést storage preflight, chráněnou konfigurační
   zálohu všech stávajících overlays a health baseline.
4. Vygenerovat jeden nový náhodný bearer přímo na produkčním hostu a zapsat
   jen `DRIVER_MEASUREMENTS_COP_TOKEN` v `/srv/sim/.env` a
   `COP_DRIVER_MEASUREMENTS_SIM_TOKEN` v `/srv/cop/.env`. Nevypisovat hodnotu.
5. HMAC tajemství a ostatní konfiguraci porovnat beze změny. Recreate pouze
   situation-data-api a COP API, bez build/pull nebo změny obrazů.
6. Starý token musí vrátit 401; nový invalid DELETE 400; platný syntetický
   DELETE 200. Předrotační fixture se smaže včetně odvozených intervalů,
   tombstone zakáže pozdní příspěvek. Ověřit skutečné volání z COP API.
7. Dokončení vyžaduje návratový kód 0 i kompletní akceptační důkazy. Chyby
   procesů nesmějí serializovat zachycené stdout/stderr nebo prostředí.

HMAC hodnoty se při bearer rotaci nemění. Jejich samostatná rotace vyžaduje
migrační plán historických pseudonymů a fronty mazání. Tato etapa neřeší
všechny ostatní přístupy zasažené předchozím diagnostickým výpisem.

## Zapnutí pro ověření

Nasadit COP pilotní filtr nejdříve s intake `false` a ověřeným allowlistem.
Pak zapnout `DRIVER_MEASUREMENTS_ENABLED=true` v SIM, ponechat
`DRIVER_MEASUREMENTS_REVOCATION_ENABLED=true`, ověřit 401/400/200,
idempotenci, aktuální verzi grafu v odpovědi a mazání. Následně COP příjem `true`, cleanup `true`
a fail-closed pilotní filtr. Telefon musí stále samostatně udělit souhlas.
Nelze prohlásit fyzický iPhone test za dokončený serverovým smoke testem.

Před instalací pilotního telefonu ověřit read-only obě zdravá API, přesné
nasazené revize/obrazy, shodu nového beareru a zachované HMAC, oba intake
flags `true`, COP pilotní filtr `true` s právě jedním ověřeným subjectem,
SIM revokaci a COP cleanup `true`. Nezapisovat identity ani secrets do
výstupu. Konečný COP obraz musí mít sanitizaci measurement logů (bez IP,
portů, body, hlaviček či parser textu) a striktní potvrzení DELETE: pouze
HTTP 200 s validním `sim-driver-measurements-v1` a nezáporným celým
`deletedBatchCount` ukončuje mazání. HTTP 202, 204 či neplatný obsah
znamená čekající/neúspěšné smazání, nikoli dokončení.

Skutečný compiled COP transport ověřit vlastní syntetickou dávkou a jejím
okamžitým smazáním; raw GPS ani reálný souhlas tím nevytvářet. Metadata
datasetu, receipt a nula vlastních zbylých intervalů nejsou důkazem
fyzické GPS akceptace. Na iPhonu zachovat stejný bundle a data, po
instalaci nezávisle ověřit verzi a běžící proces. Souhlas uživatele
udělený k instalaci není souhlas se sběrem měření v aplikaci.

Datovaný guard `scripts/enable-driver-measurement-shadow-pilot-20261011.mjs`
je připnutý k ověřenému SDA obrazu. Pod zděděným COP storage lockem FD9
vyžaduje `--enable --cop-image-id sha256:<schválený obraz COP>`, zdravý COP
s intake `false`, cleanup a pilot `true` a právě jeden platný OIDC subject.
Mění pouze SIM intake flag a restartuje pouze SDA. Patnáct syntetických
HTTP požadavků ověřuje auth/Origin, validaci, obsahovou idempotenci, konflikt,
429, odvolání, pozdní dávku a souběh; simulované polohy vytvoří nula měřených
intervalů. Vlastní fixture se smažou; selhání včetně úklidu/důkazu se pokusí
vrátit intake na `false`. `--disable` ponechá nový bearer, HMAC a revokaci.
Není to obecný deployment skript ani fyzický GPS test.

Jednoosobový pilot obvykle nevytvoří publikovatelný souhrn: stále platí
alespoň pět atestovaných přispěvatelů a deset intervalů. Použijte receipt
a chráněné počty kvality, nikoli snižování těchto prahů.

Pilotní diagnostická Jízda 1.2 (31) nabízí souhlas přes **Více → Nastavení
→ Dobrovolné dopravní údaje**. **Zastavit měření a smazat mé příspěvky**
nesmí mazat uložené jízdy, vozidla, chat ani účet COP. Po instalaci fyzicky
ověřit přihlášení a dobrovolný souhlas, krátkou skutečnou jízdu, ochranné
zóny a kvalitu bodů, offline/retry/idempotenci a odvolání s dokončeným
DELETE. Při 202 ponechat čekající stav až do konečného potvrzení; měření
je po odvolání zastavené i při nedostupném serveru.

## Data, retence a obnova

Vyhrazená DB `sim_driver_measurements` přes `haproxy.home.cz:5000`, omezený
runtime bez DDL. Produkční hardening HMACuje i klientská UUID/dedupe klíče.
Raw GPS a klientské identifikátory nejsou ukládány do DB, logů nebo cache;
zpracování polohy je přechodné v RAM SIM/Valhally. Data jsou pseudonymní,
nikoli anonymní. HMAC není důkaz nezávislého řidiče.

Sedmidenní TTL, FK cascade, průběžný úklid a samostatný 15minutový cron
zůstávají zapnuté i v revocation-only. COP 202 znamená pending; při výpadku
DB musí fronta mazání přetrvat a nepotvrdit dokončení.

PBS/WAL/PITR může obsahovat starší fyzické stránky. SQL DELETE nedokazuje
smazání ze všech záloh. Správce řídí šifrování, přístup a retenční dobu.
Obnovená measurement DB se nesmí připojit dříve než projde povinnou
obnovovací karanténou vymazávající obnovené příspěvky; COP deletion queue
se nesmí vrátit do staršího stavu.

## Rollback

Oba intake flags `false`, SIM revocation-only `true`, COP cleanup `true`.
Zachovat nový službový token, HMAC, DB a privátní síť; neobnovovat starý
bearer ani historickou DB. Restartovat pouze dotčené API. Případné vrácení
COP obrazu nesmí povolit nepilotní příjem: příjem nejprve vypnout.

Viz [ADR 0035](../adr/0035_CONTROLLED_DRIVER_MEASUREMENT_PILOT.md) a
[kontrakt Jízdy](../integration/20_JIZDA_DRIVER_MEASUREMENTS_CONTRACT.md).
