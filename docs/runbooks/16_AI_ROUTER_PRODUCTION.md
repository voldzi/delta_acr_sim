# AI Router - provozní zavedení

**Stav:** interní Router, databáze a SIM administrační proxy jsou nasazené;
textový náhled fiktivního cvičení v SIM vyžaduje produkční akceptaci. COP chat
není přepojen. Tento runbook není pokyn zapnout další typy dat nebo dražší model.

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

## Ověření lokálního izolovaného buildu (25. 9. 2026)

Node 24 typová kontrola a build prošly. Nové AI Router testy prošly. Celá SIM
test sada prošla v prostředí s povolenými lokálními porty. Docker image se
sestavil. Proti dočasné PostgreSQL 16 databázi prošla migrace, readiness,
čtení modelů/politiky/spotřeby, snížení limitu, odmítnutí překročení tvrdého
stropu, auditní zápis, odmítnutí neautorizovaného přístupu a bezpečné selhání
bez modelu. Dočasné kontejnery a síť byly odstraněny. Žádné živé OpenAI
volání ani produkční nasazení nebylo provedeno.
