# AI Router - provozní zavedení

**Stav:** interní Router, databáze, SIM administrační proxy a textový náhled
fiktivního cvičení jsou nasazené a serverově ověřené. Ekonomický tier je
povolen, dražší tier vypnutý. Běžný COP chat používá Router jen s lokálním
modelem; nová externí větev `internal_minimized` není zapnutá. Tento runbook není
pokyn zapnout další typy dat nebo dražší model.

## Vlastník a hranice

SIM vlastní repozitář a provoz AI Routeru. COP vlastní autentizaci uživatele,
výběr kontextu, AI chat a rozhodnutí o zobrazení. AI Router je samostatná
interní služba bez host portu. Výpadek neodstaví COP mapu ani SIM data.

## Předpoklady

1. Zřídit samostatnou databázi a runtime identitu za spravovaným HAProxy
   PostgreSQL endpointem. Provedení DDL jen migrační identitou; aplikace
   nemá `CREATE` oprávnění. Přesný SQL návrh je v
   [`deploy/ai-router/001_schema.sql`](../../deploy/ai-router/001_schema.sql).
   Runtime potřebuje SELECT/INSERT/UPDATE na třech tabulkách a USAGE na
   identitní sekvenci auditní tabulky.
   Pro správce je připraven
   [`scripts/provision-ai-router-postgres.sh`](../../scripts/provision-ai-router-postgres.sh):
   vyžaduje `psql`, `openssl`, terminál a administrátorský PostgreSQL účet.
   Příkazy `PGUSER=<správce> bash scripts/provision-ai-router-postgres.sh --check`
   a po kontrole `PGUSER=<správce> bash scripts/provision-ai-router-postgres.sh --apply`
   míří výhradně přes `haproxy.home.cz:5000`; heslo správce se zadává skrytě.
   Skript se při existujících objektech zastaví, nevypisuje hesla a uloží
   dvě oddělené URL do souboru s právy 600 v
   `~/.config/csm-sim/ai-router-db-credentials.env`. Jen runtime URL patří
   do produkčního `/srv/sim/.env`; migrační URL zůstává správci. Při chybě
   po založení objektů skript neprovádí destruktivní rollback; správce má
   zkontrolovat částečný stav a uložené přihlašovací údaje.
   Na macOS je dostupné `--recover` pro konkrétní případ, kdy databáze i oba
   účty vznikly, ale skript se zastavil před uložením přístupových údajů.
   Obnova ověřuje vlastníka databáze a omezení rolí, nastaví jim nová hesla,
   uloží je a dokončí schéma; nepoužívat ji při jiném nebo neznámém stavu.
2. Do ignorovaného produkčního `.env` dodat nezávislé dlouhé tokeny pro COP,
   SIM a správce a pepper uživatelských identifikátorů. Nepoužívat SIM
   administrační token jako Router token. Databázová URL se nikdy nevypisuje.
3. Existující OpenAI klíč lze pro Router použít po potvrzení cílového
   produkčního env souboru. Přenáší se pouze hodnota `OPENAI_API_KEY`, nikdy
   celý COP `.env`; v Gitu se neukládá. Shodný klíč ale neznamená úplnou
   routerovou evidenci dosavadních COP volání.
4. Vybrat lokální model a interní adresu Ollama. Produkční COP chat zůstává
   na dosavadní cestě; připravený typovaný kontrakt sám žádné COP volání
   nepřepíná.

## Bezpečný postup

1. Zálohovat databázi a dosavadní SIM deployment manifest; zaznamenat
   konkrétní release a rollback bod.
2. Aplikovat migrační SQL migrační identitou. Ověřit tabulky a oprávnění
   runtime identity bez prohlížení dat či hesel.
3. Sestavit kontejner z ověřeného commitu. Compose profil `ai-router` je
   opt-in; výchozí stack se nemění. Při startu ponechat
   `AI_ROUTER_EXTERNAL_ENABLED=false` a `AI_ROUTER_ADVANCED_ENABLED=false`.
4. Ověřit `/health/ready`, interní autorizaci, přístup správce z SIM a
   zákaz přímého browserového volání. Zkontrolovat, že změna politiky má
   auditní záznam a nadlimitní nastavení selže.
5. Ověřit pouze syntetický SIM dotaz a bezpečné selhání lokálního providera.
   Produkční COP chat nepřepojovat před samostatnými COP testy.
6. Teprve po souhlasu a testu ochrany dat povolit ekonomický externí tier
   pro přesně schválenou úlohu. Pokročilý tier vyžaduje zvláštní schválení.

## Kontroly před aktivací

- Transakční test souběžných rezervací vůči dennímu a měsíčnímu stropu.
- Odmítnutí `internal` dat pro externí model; COP chat smí externě jen
  atestovanou syntetickou nebo veřejně agregovanou třídu s výslovným opt-in;
  `internal_minimized` je oddělená schopnost vypnutá do společné akceptace.
- Nefunkční DB, lokální i externí provider; žádné obejití rozpočtu.
- Cena porovnaná s aktuálním účtem poskytovatele, včetně regionu a zvoleného
  režimu. Interní odhad není faktura.
- SIM admin vidí jen Router spotřebu, nikoli úplné OpenAI náklady účtu.
- Akceptační test COP chatu, E2EE hranice a rollback na dosavadní COP AI.

## Návrat

Vypnout Compose profil služby nebo externí přístup, COP nechat na stávající
AI gateway. Rozpočtové a auditní záznamy ponechat; tabulky nemazat při
rollbacku. Rotaci nebo odebrání klíče řešit samostatně, protože tentýž klíč
může používat COP.
Pro okamžité zastavení AI volání lze na `docker.home.cz` zastavit pouze
`ai-router-api` v projektu `sim`; SIM náhled pak bezpečně vrátí 503 a jiné
vrstvy pokračují. Předchozí obrazy API a webu jsou označené
`sim-sim-api:pre-ai-router-20260925` a `sim-sim-web:pre-ai-router-20260925`.
Produkční `.env` má zálohy se značkou `before-ai-router-*` v `/srv/sim`;
neodstraňovat je bez samostatného rozhodnutí.

## Ověření lokálního izolovaného buildu (25. 9. 2026)

Node 24 typová kontrola a build prošly. Nové AI Router testy prošly. Celá SIM
test sada tehdy prošla v prostředí s povolenými lokálními porty. Docker image se
sestavil. Proti dočasné PostgreSQL 16 databázi prošla migrace, readiness,
čtení modelů/politiky/spotřeby, snížení limitu, odmítnutí překročení tvrdého
stropu, auditní zápis, odmítnutí neautorizovaného přístupu a bezpečné selhání
bez modelu. Dočasné kontejnery a síť byly odstraněny. V tomto počátečním
izolovaném testu nebylo provedeno žádné živé OpenAI volání.

## Produkční akceptace SIM (25. 9. 2026)

- Commit `a9ca469`; dotčeny a restartovány pouze `ai-router-api`, `sim-api`
  a `sim-web`. Ostatní datové služby nebyly restartovány a zůstaly healthy.
- Router nemá publikovaný host port, `/health/ready` vrací 200,
  neautorizované volání 401. SIM admin proxy vrací 200; pokus nastavit
  `1,000001 USD/den` (nad schválený 1 USD) vrací 400 bez změny politiky. Změna politiky má jeden
  auditní záznam v oddělené databázi přes HAProxy.
- `SIM_AI_USER` preview odmítá požadavek bez potvrzení fiktivnosti (400), při vypnutém
  provideru selhává uzavřeně (503). Po povolení pouze `gpt-6-luna` prošel
  jeden fiktivní civilní test přes SIM API: HTTP 200, lidská kontrola=true,
  délka výstupu 381 znaků, odhad 146 µUSD. Spotřeba v SIM ukázala jeden
  požadavek a 146 µUSD; pokročilý tier zůstal vypnutý.
- Typová kontrola, cílené testy Routeru (14) a SIM API (32), build, OpenAPI
  validace a skeleton kontrola prošly. První souběžný běh celé sady vykázal
  přechodné 404 v nesouvisejícím testu referenčního typu letadla; samostatný
  opakovaný test letových dat (24) i následný opakovaný běh celé sady prošly.
  Vizuální acceptance v přihlášeném prohlížeči proběhla 25. 9. 2026:
  správce viděl `gpt-6-luna`, denní 1 USD, měsíční 10 USD a 10 dotazů;
  fiktivní náhled povodňového cvičení se zobrazil a nepublikoval.

## Připravený COP pilot agregovaného souhrnu

COP může opt-in použít stejný Router pouze pro auditovaný MCP souhrn stavu
zdrojů. Před přepnutím ověřit kompatibilní verzi obou služeb, vložit do
`/srv/cop/.env` pouze dedikovaný `AI_ROUTER_COP_TOKEN` jako
`COP_AI_ROUTER_TOKEN`, nastavit interní URL a vypnout původní přímé volání
této funkce. Tokeny ani hodnoty env se nevypisují. Produkční COP chat a
situační shrnutí zůstávají beze změny. Výpadek Routeru znamená jen 503 pro
MCP souhrn a jeho spotřebu. Návrat se provádí vypnutím COP přepínače a
restartem pouze `cop-api`; databázová evidence se nemaže.
Na hostu jsou `cop_default` a `sim_default` oddělené. Před aktivací je
potřeba výslovně schválené interní propojení pouze COP API a Routeru;
nepublikovat host port ani nepřipojovat všechny služby obou projektů.

## Strukturovaný návrh SIM

`POST /api/v1/ai/router-scenario-drafts` vyžaduje roli `SIM_AI_USER`,
fiktivní zadání do 2000 znaků a potvrzení `syntheticOnly=true`. Odpověď
modelu je striktní čtyřpoložkový JSON; server nepřijímá modelové bloky,
oblast ani publikační pravidla. Jediný výstupní blok je `report-sim`.
Neplatný výstup končí 503 bez uloženého návrhu. Platný návrh má auditní
request ID a stav čekající na lidskou kontrolu; nevytváří aktivní scénář.
Před produkčním používáním ověřit zvlášť 400 při chybějícím potvrzení,
503 při neplatném JSON, validaci návrhu a ruční přijetí pouze v testovacím
fiktivním kontextu.

## Kontrakt COP chatu a připravená minimalizovaná větev — bez aktivace

Router již umí rozlišit interní, fiktivní a veřejně agregovaný `cop_chat`.
Jen službový token COP s typovaným `copContext`, atestací
`cop-policy-reviewed-v1`, `allowExternal=true` a třídou `synthetic` či
`public_aggregate` může po výslovné volbě nebo politice použít
`gpt-6-luna`. Interní třída smí jen lokální model. Drahý model nelze pro
COP chat vyžádat. Závazné schéma je v `openapi/openapi.json`, příklad a
odpovědnosti v `docs/ai/10_SHARED_AI_ROUTER.md`.

COP commit `623927f` připravil na straně COP odpojený adaptér
`internal_minimized`. Router pro něj přijímá jen COP službový token,
`taskType=cop_chat`, neprůhledné `userId`, zkontrolovanou otázku do 1200
znaků, `preference=external`, `allowExternal=true`, explicitní
`allowPaidEscalation=false` a přesnou atestaci
`cop-internal-minimized-reviewed-v1`. `copContext.items` má 0–12 položek a
smí obsahovat pouze omezený `source_health` nebo `operational_metric` bez
volného textu. Další klíče i chybné třídy vrací 400. Jiná konfigurace
ekonomického modelu než `gpt-6-luna` vrací 503; 429/503 nespouští přímý
fallback. Přepínač `AI_ROUTER_COP_INTERNAL_MINIMIZED_ENABLED` je výchozím
nastavením `false`, nezávisle na ostatním externím provozu.

**Před zapnutím přepínače** vlastník COP/SIM společně doloží: (1) schválení
účelu a souhlasu pro externí zpracování; (2) identitu konkrétního OpenAI API
projektu, jeho zpracovatelský vztah, retenční režim a případné schválení
Modified Abuse Monitoring/Zero Data Retention; (3) požadovanou rezidenci a
správný regionální endpoint, pokud je sjednána; (4) dostupnost
`gpt-6-luna` pro projekt a aktuální cenu; (5) společné testy autentizace,
minimalizace, 429, výpadků, rozpočtu, spotřeby v SIM a návratu. Aktuální
Router volá `api.openai.com` se `store:false`; to samo **nedokazuje** nulové
uchování ani evropskou rezidenci. Viz
[OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)
a [katalog Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).

Nasazení této změny kódu Routeru samo **nezapíná** externí COP chat. Síťové
propojení COP API ↔ Router, přenos dedikovaného COP tokenu a přepnutí chatu
vyžadují samostatný výslovný souhlas. Při schválené akceptaci: (1) zaznamenat
image a politiku Routeru jako rollback bod, (2) nasadit pouze Router z
ověřeného commitu, (3) v interní izolované zkoušce ověřit obě povolené
třídy, odmítnutí `internal`/neplatné klasifikace, hashované uživatelské ID,
1 USD/den, 10 USD/měsíc, 10 požadavků/uživatele/den, SIM přehled tokenů a
odhadů, nedostupnost DB a obou modelů, (4) teprve po společném testu COP
policy gate a klasifikace schválit oddělenou interní síť a COP token, (5)
ověřit produkční COP chat bez chráněných dat a bez přímého OpenAI bypassu.

Návrat před zapnutím COP: obnovit předchozí Router image a restartovat pouze
`ai-router-api`, zachovat auditní databázi; SIM fiktivní náhled lze dočasně
vypnout samostatně. Po případném pozdějším přepnutí COP vrátit nejprve jeho
chatový přepínač na původní cestu a restartovat jen `cop-api`; teprve pak
vracet Router image. Neodstraňovat databázové záznamy ani klíče při rollbacku.

## Nasazení vypnutého kontraktu (27. 9. 2026)

Commit `f3c77fe` byl na produkční větvi `/srv/sim` převzat jako `5f31a51`.
Přestavěn a restartován byl pouze `ai-router-api`; předchozí image má digest
`sha256:f1835a7dbb51709a554236eb2dedeacf3a7723eadbfb8764bd91af957ae8a2a0`,
nový `sha256:39e3bb41bf8088ce2ac1a17d0f73f9efe0560ffa389c68544ab13dfb4b09d7af`.
Ostatní služby SIM zůstaly healthy. Router `/health/ready` vrátil 200 a
autentizované čtení agregované spotřeby 200. Neautorizovaný požadavek na
`internal_minimized` vrátil 401, textová položka 400 `invalid_request` a
platný minimální kontext 503 `internal_minimized_not_enabled`. Tím byl
ověřen nasazený kontrakt bez volání OpenAI. Přepínač zůstal vypnutý;
produkční COP chat se nepřepnul. Plný pozitivní test čeká na kontrolu
nastavení konkrétního OpenAI projektu a společnou akceptaci COP/SIM.

## Oddělené cesty COP BYOK a SIM/IZS — nasazené, neaktivní

Nový [kontrakt a akceptační postup](../ai/11_COP_BYOK_AND_SIM_IZS_ROUTER.md)
vyžaduje migraci `deploy/ai-router/002_separate_billing.sql` v existující
oddělené databázi Routeru, nové oddělené HMAC/šifrovací tajemství a kontrolu
projektu OpenAI. **Nepovolovat** `AI_ROUTER_COP_BYOK_ENABLED` ani
`AI_ROUTER_SIM_IZS_ENABLED` pouhým nasazením image. `OPENAI_API_KEY` lze
použít pro syntetické vývojové ověření SIM; vlastnictví nového produkčního
projektu tím není prokázáno. Společná akceptace, rozpočty a přepnutí COP
chatu jsou samostatné kroky. Při chybě ponechat oba přepínače vypnuté a
stávající lokální COP chat v provozu; auditní tabulky zachovat.

### Produkční nasazení 27. 9. 2026

- Aditivní migrace `002_separate_billing.sql` prošla v oddělené databázi
  `sim_ai_router` přes HAProxy. Běhový účet vidí nové tabulky a má ověřená
  potřebná práva. Přihlašovací údaje nebyly přidány do repozitáře.
- Commit `32a953f` byl do produkční větve převzat jako `e857696`.
  Dotčeny a restartovány byly pouze `ai-router-api`, `sim-api` a `sim-web`;
  jiné datové služby zůstaly healthy. Nesouvisející rozpracovaný soubor
  `deploy/otel-collector.yaml` zůstal nedotčen.
- Nové obrazy: Router `sha256:ce95093a1f871db37c3f9737193ca709ab1b3624b30f385ca968c0edd871d762`,
  SIM API `sha256:e2b61d0d0aace9168ab0b0410dc129e8e78963fe48cf6f17b03b469de1607a7f`,
  SIM web `sha256:c6e756cda935a51540e1ab453e0f3810dac1c2cc05464f680a460bffb3e6a999`.
  Původní obrazy zůstávají označené `:pre-byok-20260927` pro návrat.
- Všechny tři kontejnery jsou healthy; interní Router `/health/ready`
  vrátil 200. COP BYOK vrátil 503 `cop_byok_not_enabled`; IZS službový token
  zatím není nastaven. Router port 4050 nemá host mapping. SIM admin proxy
  vrátila 200 a oddělenou knihu označila `not_enabled`. Veřejný live
  healthcheck vrátil 200, interní readiness přes web bez autentizace 401
  podle stávajícího přístupového pravidla.
- Na interním disku zůstalo 39 GB volných; žádné staré soubory ani cache
  nebylo kvůli nasazení nutné mazat. Zálohy env a návratové obrazy se
  ponechávají. Nebyl proveden produkční dotaz na OpenAI, přepnutí COP chatu
  ani aktivace SIM/IZS úlohy.
- Doplňkový fiktivní canary dosavadní lokální cesty `cop_chat/internal`
  vrátil 503 `model_unavailable`: Router má stále nastaven
  `gemma4:12b-mlx` na `192.168.200.2:11434`, ale HTTP dotaz na tento
  endpoint timeoutuje i přímo z hostu `docker.home.cz`. Nejde o aktivaci
  nové externí větve ani o chybu databázové migrace; stav lokálního
  poskytovatele/vnitřního spojení vyžaduje samostatné obnovení a poté
  opakovaný chatový test. VPN, VLAN ani firewall se v rámci nasazení
  neměnily.

### Více adres lokální Ollamy

Při migraci na zařízení dostupné přes LAN i VPN použít v ignorovaném
`/srv/sim/.env` pořadí
`AI_ROUTER_LOCAL_URLS=http://192.168.1.176:11434,http://192.168.200.1:11434,http://192.168.200.2:11434`.
Router před odesláním interní otázky načte `/api/tags` s krátkým timeoutem a
požaduje přesný `AI_ROUTER_LOCAL_MODEL`; nefunkční adresu či adresu bez modelu
přeskočí. Stará `AI_ROUTER_LOCAL_URL` zůstává pro návrat. Interní třída nemá
externí fallback. Funkční ověření musí obsahovat `/health/ready` a fiktivní
`cop_chat/internal` s odpovědí `local_fast`; samotný stav kontejneru nestačí.
Vrácení: obnovit předchozí image Routeru a původní `.env`, případně odstranit
novou proměnnou; ostatní SIM služby a COP chat se nepřepínají.
