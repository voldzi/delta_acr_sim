# AI Router - provozní zavedení

**Stav:** interní Router, databáze, SIM administrační proxy a textový náhled
fiktivního cvičení jsou nasazené a serverově ověřené. Ekonomický tier je
povolen, dražší tier vypnutý. COP chat není přepojen. Tento runbook není
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
4. Vybrat lokální model a interní adresu Ollama. COP chat zůstává v první
   fázi lokální, i pokud se externí model později zapne pro jiné úlohy.

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
- Odmítnutí `internal` dat pro externí model; `cop_chat` pouze lokálně.
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
