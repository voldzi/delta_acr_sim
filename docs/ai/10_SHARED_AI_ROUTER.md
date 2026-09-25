# Sdílený AI Router - architektonické zadání a stav realizace

**Stav 25. 9. 2026:** Interní Router a administrační panel SIM jsou nasazené.
Samostatná interní služba, směrovací pravidla, REST kontrakt a databázová
rezervace rozpočtu. Textový náhled fiktivního cvičení je připojen v SIM a
prošel serverovým produkčním testem. Levný externí tier je povolen pouze v
mezích politiky; dražší model je vypnutý. COP chat zůstává na dosavadní cestě.

## Cíl

Jednotné řízené modelové volání pro COP a SIM s volbou modelu, ochranou dat,
nákladovými stropy a vysvětlitelným směrováním. Administrátor má v SIM vidět
modely a skutečnou routerovou spotřebu, měnit povolení a limity až přes
autorizovaný serverový proxy a audit. Rozhraní COP pro koncového uživatele
zůstává jednotné; Router není veřejné UI.

## Odpovědnosti

| Systém                                     | Vlastnictví                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| COP                                        | Uživatel, role, kontext, chat, schválení, citace a odpověď v UI.         |
| SIM                                        | Provenance dat, scénáře, administrativní UI.                             |
| AI Router                                  | Modelová politika, provider volání, rozpočty, spotřeba, důvod směrování. |
| PostgreSQL přes schválený HAProxy endpoint | Autoritativní evidence rezervací a spotřeby Routeru.                     |

## V1 kontrakt

- `POST /api/v1/ai-router/generate`: interní bearer COP/SIM, `taskType`,
  `dataClass`, `userId`, prompt, model preference a explicitní povolení
  externího/dražšího modelu. Vrací request ID, model, tier, důvod směrování,
  tokeny, interní odhad ceny a `requiresHumanReview=true`.
- `GET /api/v1/ai-router/models`: dostupnost nakonfigurovaných modelových tierů.
- `GET /api/v1/ai-router/usage`: autentizované služby COP/SIM a správce;
  pouze celkové denní/měsíční součty, tokeny a limity, bez identit či promptů.
- `GET/PATCH /api/v1/ai-router/policy`: uložená provozní politika. Změna je
  auditovaná v DB, lze jen v mezích tvrdých limitů z prostředí.
- SIM API proxy `/api/v1/ai/router-admin` a `/policy`: jen `SIM_AI_ADMIN`;
  prohlížeč nedostává interní Router token.
- SIM API proxy `POST /api/v1/ai/router-scenario-preview`: jen `SIM_AI_USER`,
  nejvýše 2000 znaků, výslovné označení fiktivního zadání. Volá Router pod
  samostatnou SIM identitou, vrací text pro lidské posouzení a nic neukládá
  jako scénář ani nepublikuje. Původní strukturovaný mock draft zůstává
  oddělený a je v UI takto označen.
- SIM API proxy `POST /api/v1/ai/router-scenario-drafts`: jen `SIM_AI_USER`
  a výslovně fiktivní zadání. Model vrací pouze striktní JSON se jménem,
  popisem, dobou a počtem. Server odmítá další pole, zakázaný obsah a
  neplatné limity; sám skládá jediný civilní blok `report-sim`, validuje
  schéma a ukládá pouze návrh se stavem čekajícím na lidské přijetí.
  Nevytváří aktivní scénář ani nic nepublikuje.
- `/health/live` a `/health/ready`: proces a dosažitelnost databáze.

Kontrakt záměrně neumožňuje přímou manipulaci s tool registry, volné URL
providera, nahrávání příloh, změnu ceníku v requestu ani zápis do COP/SIM.
Request je omezen velikostí, výstupem a timeoutem. Odpověď neobsahuje secret.

## Router v první fázi

- Lokální Ollama je volitelný fast provider. Externí přístup je výchozím
  nastavením vypnutý; ekonomický tier je `gpt-6-luna`, pokročilý tier
  `gpt-6-sol` je samostatně vypnutý. Povolení nákladného tieru musí být
  explicitní na úrovni prostředí i požadavku.
- `internal` data nikdy nejdou na externí model. Automatická volba dává
  jednoduchému dotazu přednostně lokální model. Když bezpečná cesta není
  dostupná, požadavek selže uzavřeně.
- Připravený kontrakt `cop_chat` připouští `gpt-6-luna` pouze pro
  autentizovanou službu COP, `allowExternal=true`, třídu `synthetic` nebo
  `public_aggregate` a platný `copContext` s atestací COP. Drahý tier je pro
  COP chat zakázán. `internal` zůstává výhradně lokální; bez lokálního modelu
  vrací 503. Tento kontrakt není zapnutím produkčního chatu COP.
- `source_health` smí mít jen `public_aggregate` a `sim_scenario` jen
  `synthetic`.
- Denní a měsíční limity mají tvrdé výchozí stropy 1 a 10 USD, 10 dotazů na
  uživatele za den. Správce je v SIM může snížit a v mezích stropu povolit
  modelové tiery; vyšší strop vyžaduje samostatnou změnu prostředí.
  PostgreSQL transakce a advisory lock brání paralelnímu
  přečerpání rezervací. Neúspěšný provider rezervaci ponechá.
- `store: false`; žádný modelový tool calling. Před voláním se rezervuje
  konzervativní maximum, po úspěchu se v Routeru eviduje odhad z vráceného
  počtu tokenů. Ani tento odhad není faktura. Ceník je nutno pravidelně
  kontrolovat.
  Výchozí sazby a podporu `gpt-6-luna` ověřujeme proti
  [oficiálnímu katalogu modelů](https://developers.openai.com/api/docs/models/gpt-6-luna)
  a [ceníku OpenAI API](https://developers.openai.com/api/docs/pricing)
  (kontrola 25. 9. 2026); kód rezervuje dvojnásobek standardní sazby pro
  krátké textové požadavky. Regionální, prioritní či dlouhý kontext se před
  zapnutím musí posoudit zvlášť.

## Otevřené kroky

### Přesný předávací kontrakt pro budoucí COP chat

COP volá výhradně interní `POST /api/v1/ai-router/generate` s vlastní
službovou bearer identitou. `taskType` je `cop_chat`, `dataClass` je vždy
výslovně jedna z `internal`, `synthetic`, `public_aggregate`; chybějící nebo
jiná hodnota končí 400. `userId` je stabilní neprůhledný identifikátor
8–128 znaků `[A-Za-z0-9_-]`, ne jméno ani e-mail. Router ho ukládá pouze
hashovaný. `prompt` je COP zkontrolovaná otázka nejvýše 1200 znaků, nikdy
historie chatu ani přiložený volný situační kontext. `copContext` má vždy
`contractVersion="cop-chat-context-v1"` a `dataClass` shodnou s requestem.
Jiná pole na jakékoli úrovni strukturovaného kontextu se odmítají.

- `internal`: `copContext` obsahuje jen verzi a `dataClass`. COP neposílá
  externí povolení; Router použije pouze lokální model, jinak vrátí 503.
- `synthetic`: kontext obsahuje `attestation="cop-policy-reviewed-v1"`,
  neprůhledné `scenarioId` a 1–12 výslovně fiktivních faktů do 240 znaků.
  COP musí izolovat cvičení od skutečných záznamů.
- `public_aggregate`: kontext obsahuje stejnou atestaci a 1–20 číselných
  agregátů. Každý má omezené kódy `sourceId`, `metricId`, pouze stát/kraj
  (`CZ` či `CZ` + tři číslice), počátek a konec období alespoň hodinu od
  sebe, konečnou číselnou hodnotu, jednotku z `count|percent|minutes|km|index`
  a `sampleSize>=10`. Nejsou zde textové záznamy, souřadnice ani jednotlivé
  incidenty. Ukázka:

```json
{
  "taskType": "cop_chat",
  "dataClass": "public_aggregate",
  "preference": "external",
  "prompt": "Shrň vývoj tohoto veřejného souhrnu.",
  "userId": "cop_user_opaque_123456",
  "allowExternal": true,
  "copContext": {
    "contractVersion": "cop-chat-context-v1",
    "dataClass": "public_aggregate",
    "attestation": "cop-policy-reviewed-v1",
    "aggregates": [{
      "sourceId": "chmi_weather_stations", "metricId": "station_count",
      "regionCode": "CZ010", "periodStart": "2026-09-24T00:00:00Z",
      "periodEnd": "2026-09-25T00:00:00Z", "value": 42,
      "unit": "count", "sampleSize": 42
    }]
  }
}
```

Router sám kontroluje službový token, tvar a shodu klasifikace, atestaci,
externí opt-in, zákaz dražšího modelu, volbu modelu, limity a audit tokenů
a odhadu ceny. Nemůže prokázat, že COP označil skutečně veřejná či fiktivní
data správně, že agregát vznikl z povoleného zdroje, ani že otázka neobsahuje
osobní či citlivé údaje. To je povinná předávací kontrola COP. Dešifrované
soukromé zprávy, osobní údaje, citlivé incidenty, neupravené situační
záznamy a volný kontext nejsou `public_aggregate`; tyto vstupy nesmějí být
externě předány. COP nesmí přímo volat OpenAI jako náhradní cestu při 429/503.

1. Vizuální acceptance SIM panelu v přihlášeném prohlížeči proběhla
   25. 9. 2026: přihlášený správce viděl modely a limity, fiktivní náhled
   přes `gpt-6-luna` se zobrazil a zůstal bez publikování. Detailnější
   grafy spotřeby ještě nejsou hotové.
2. COP adaptér pro existující agregovaný MCP souhrn stavu zdrojů je připraven
   opt-in. Před nasazením je nutné dokončit integrační ověření, předat
   dedikovaný COP token a potvrdit přesný rollback. Matrix E2EE, COP chat a
   situační shrnutí nejsou touto změnou přepojeny.
3. Strukturovaný AI draft pro civilní fiktivní hlášení je implementován
   odděleně od starého mock návrhu. Před označením produkčně přijatým musí
   projít vizuální zkouškou a skutečným fiktivním dotazem přes nový endpoint;
   lidské schválení scénáře a pozdější spuštění zůstávají samostatné kroky.
4. Existující klíč byl zpřístupněn Routeru bez zveřejnění. Samotný stejný
   klíč nezajistí úplné účetnictví: COP volání mimo Router se zde
   nezapočítají. Pro úplný součet je třeba migrovat všechny placené cesty
   nebo porovnávat s účtem poskytovatele.
5. Jeden produkční end-to-end test s čistě fiktivními daty prošel. Ještě zbývá
   širší paralelní zátěž limitů, výpadky DB a providera, rollbackové cvičení
   a provozní alerty.

## Nasazení a návrat

Služba je izolovaná Compose profilem `ai-router`; bez profilu se nespouští.
Nesmí mít publikovaný host port. Připojení k PostgreSQL míří na spravovaný
HAProxy endpoint, nikoli přímo na Patroni nod. Nový klíč se nevytváří;
existující klíč lze po schválení vložit do runtime env mimo Git. Pro návrat
vypnout profil/externí přístup a ponechat COP na stávající AI gateway.
