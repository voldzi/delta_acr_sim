# ADR 0026: Oddělené účtování COP BYOK a SIM/IZS v AI Routeru

**Stav:** kontrakt nasazen v neaktivním režimu; produkční aktivace čeká na společnou akceptaci.
**Datum:** 27. 9. 2026.

## Kontext

Dosavadní Router používá jeden projektový OpenAI klíč a jednu společnou
rezervační politiku. COP chce zachovat jeden chat, ale platit výchozí externí
dotazy klíčem přihlášeného uživatele. SIM potřebuje samostatnou úlohu a
projekt pro lidsky kontrolované souhrny IZS. Projekt OpenAI Global je pro
tento návrh přijatelný; není to souhlas se skrytým přidáváním chráněných dat.

## Rozhodnutí

1. Stávající `POST /api/v1/ai-router/generate` zůstává kompatibilní. Přidávají
   se explicitní interní cesty `/cop/chat` a `/sim/izs-summary`; klient nikdy
   neposílá volbu cizího účtu, projektového klíče ani modelu.
2. COP předá službový token a krátce platnou podepsanou identitu uživatele.
   Router podle ní sám vybere šifrovaný uživatelský klíč. Správa klíče má
   oddělené GET/PUT/DELETE `.../cop/users/me/openai-key`. COP může klíč pouze
   bezpečně předat, nesmí jej ukládat ani logovat. Chybějící klíč nevede na
   účet SIM/COP.
3. Uživatelem napsaná otázka je oddělena od typovaného automatického
   kontextu. Kontext nemá volná textová pole; vyžaduje publikovaný stav,
   povolený `sourceId`, původ, referenci publikace, čas pozorování,
   publikace a konec platnosti. COP odpovídá za pravdivost klasifikace a
   oprávnění zdroje. Router ověří tvar, limity a allowlist, nikoli skutečný
   právní/statusový původ dat.
4. SIM/IZS používá vlastní službový token, roli `SIM_IZS_ANALYST`, projektový
   klíč, rozpočtovou knihu a audit. Pilot přijímá jen fiktivní fakta nebo
   kontrolované publikované číselné položky; skutečné interní incidenty
   se na tuto externí cestu neposílají. Výstup je vždy návrh pro člověka.
5. AES-256-GCM klíč pro šifrování uživatelských API klíčů se drží odděleně od
   PostgreSQL a jejích záloh. Záznam požadavku obsahuje pouze HMAC otisk
   použitého klíče, účtovací zdroj, uživatele jako neprůhledný hash, model,
   tokeny a odhad ceny. Klíče ani prompty se nelogují.
6. Globální zákaz externích modelů platí i pro nové větve. Nové přepínače jsou
   výchozím nastavením vypnuté. Den/měsíc a limit uživatele se rezervují před
   voláním. Nejasný výsledek po odeslání není automaticky opakován a může
   být poskytovatelem účtován; rezervace zůstává pro následné vyrovnání.
7. `gpt-5.4-mini` je kandidát na syntetické SIM/IZS vyhodnocení, nikoli
   automatická produkční volba kvůli případným bezplatným tokenům. Přesný
   OpenAI projekt, jeho nastavení sdílení dat a skutečná fakturace musí být
   ověřeny. Zapnutí placeného překročení vyžaduje výslovně schválený rozpočet.

## Důsledky

- Přibývá správa cizích tajemství, migrace schématu a provozní povinnost
  rotace šifrovacího klíče. Logické odstranění klíče nevymaže starší zálohy;
  uživatel musí případně klíč zneplatnit i v OpenAI.
- Odhad v SIM není faktura. Vlastní projekt uživatele může mít i provoz mimo
  Router; absolutní strop celé jeho OpenAI organizace Router nezaručí.
- Samotný `store:false` nevylučuje všechny retenční záznamy poskytovatele.
- Přepnutí chatu COP, sdílení vstupů/výstupů, IZS přístup a případná migrace
  projektu jsou samostatné akceptační kroky; tento commit je neaktivuje.

## Návrat

Vypnout `AI_ROUTER_COP_BYOK_ENABLED` a `AI_ROUTER_SIM_IZS_ENABLED`; ponechat
dosavadní lokální COP chat. Databázi a audit ponechat pro vyúčtování a obnovu.
Nevracet se automaticky na sdílený placený klíč ani na přímé volání OpenAI.
