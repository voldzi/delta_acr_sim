# Sdílený AI Router - architektonické zadání a stav realizace

**Stav 25. 9. 2026:** Interní Router a administrační panel SIM jsou nasazené.
Samostatná interní služba, směrovací pravidla, REST kontrakt a databázová
rezervace rozpočtu. Textový náhled fiktivního cvičení je připojen v SIM; jeho
produkční akceptace se ověřuje. COP chat zůstává na dosavadní cestě.

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
- `GET /api/v1/ai-router/usage`: jen správce; denní/měsíční spotřeba a limity.
- `GET/PATCH /api/v1/ai-router/policy`: uložená provozní politika. Změna je
  auditovaná v DB, lze jen v mezích tvrdých limitů z prostředí.
- SIM API proxy `/api/v1/ai/router-admin` a `/policy`: jen `SIM_AI_ADMIN`;
  prohlížeč nedostává interní Router token.
- SIM API proxy `POST /api/v1/ai/router-scenario-preview`: jen `SIM_AI_USER`,
  nejvýše 2000 znaků, výslovné označení fiktivního zadání. Volá Router pod
  samostatnou SIM identitou, vrací text pro lidské posouzení a nic neukládá
  jako scénář ani nepublikuje. Původní strukturovaný mock draft zůstává
  oddělený a je v UI takto označen.
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
- `cop_chat` je ve V1 vždy pouze lokální, i kdyby konzument požadoval externí
  model. `source_health` smí mít jen `public_aggregate` a `sim_scenario` jen
  `synthetic`. Teprve samostatné posouzení může tuto politiku změnit.
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

## Co ještě chybí před provozem

1. Provozní a vizuální acceptance připraveného SIM panelu, detailnější grafy
   spotřeby a administrátorské testy proti běžící Router službě.
2. Integrace COP AI gateway; nezměnit Matrix
   E2EE hranici, současné AI chat workflow ani fallback bez testů.
3. Strukturovaný AI draft v SIM zůstává ukázkový; nový textový náhled přes
   Router jej nenahrazuje a nic nevytváří automaticky. Případná tvorba
   strukturovaného scénáře modelem vyžaduje samostatnou validaci a schválení.
4. Bezpečné zpřístupnění již existujícího klíče druhé službě. Samotný
   stejný klíč nezajistí úplné účetnictví: COP volání mimo Router se zde
   nezapočítají. Pro úplný součet je třeba migrovat všechny placené cesty
   nebo porovnávat s účtem poskytovatele.
5. End-to-end test s neprodukčními daty, paralelní zátěž limitů, výpadky DB,
   providera, odmítnutí externích interních dat, rollback a provozní alerty.

## Nasazení a návrat

Služba je izolovaná Compose profilem `ai-router`; bez profilu se nespouští.
Nesmí mít publikovaný host port. Připojení k PostgreSQL míří na spravovaný
HAProxy endpoint, nikoli přímo na Patroni nod. Nový klíč se nevytváří;
existující klíč lze po schválení vložit do runtime env mimo Git. Pro návrat
vypnout profil/externí přístup a ponechat COP na stávající AI gateway.
