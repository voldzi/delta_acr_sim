# COP BYOK a samostatné analýzy SIM/IZS

**Stav k 27. 9. 2026:** kontrakt, migrace a tři dotčené služby SIM jsou
nasazené; oba produkční přepínače nových větví zůstávají vypnuté. Není
potvrzen skutečný OpenAI projekt, nárok na pobídku
bezplatných tokenů, živá fakturace, COP adaptér ani akceptace IZS. Tato část
není pokynem přepnout běžný chat COP.

## Rozdělení cest

| Cesta | Kdo předává identitu | Poskytovatel a plátce | Hranice obsahu |
| --- | --- | --- | --- |
| COP chat | COP API: službový token + HMAC podepsané `sub` přihlášeného uživatele | Router vybere pouze jeho uložený projektový klíč; `gpt-6-luna` | Uživatelem napsaná otázka; volitelně typovaný publikovaný kontext |
| SIM/IZS souhrn | SIM API po kontrole `SIM_IZS_ANALYST`: samostatný token a neprůhledný hash operátora | Projektový klíč SIM; pilot `gpt-5.4-mini` | Jen syntetická fakta nebo publikované číselné položky; lidská kontrola |

Žádná cesta nepřebírá `userId`, klíč, model, URL poskytovatele nebo projekt
z klientského těla. `billingSource` je ve schématu výslovná konstanta,
ověřovaná serverem. Chybějící, chybný nebo odebraný uživatelský klíč nevede
k použití sdíleného klíče SIM/COP. Neexistuje přímá náhradní OpenAI cesta.

## Kontrakt COP

Pouze interní server COP volá `PUT/GET/DELETE
/api/v1/ai-router/cop/users/me/openai-key` a `POST
/api/v1/ai-router/cop/chat` s dedikovaným bearer tokenem. Hlavička
`x-cop-actor` je base64url JSON obsahující **přesně** neprůhledné `sub`
(8–128 znaků `[A-Za-z0-9_-]`), `aud="sim-ai-router"`, unixové `iat` a
`exp` s platností nejvýše 60 s. Hlavička `x-cop-actor-signature` je malými
hexadecimálními znaky HMAC-SHA256 celého nezměněného `x-cop-actor` pod
odděleným sdíleným tajemstvím. Identitu odvozuje COP z přihlášeného sezení;
prohlížeč nesmí žádnou z těchto hlaviček určovat. COP musí před předáním
klíče uživatele upozornit na ukládání klíče v Routeru a vyloučit tělo
požadavku a `Authorization` z logů.

`PUT` přijímá pouze `{ "apiKey": "…" }`, provádí základní kontrolu přístupu
k metadatům povoleného modelu bez generování textu (neprokazuje dostupný
kredit ani budoucí úspěch volání), ukládá AES-256-GCM šifrovanou hodnotu a vrací jen
`configured` a neprůhledný otisk. `GET` nikdy nevrací klíč. `DELETE` klíč
logicky odstraní; neodvolá jej automaticky u OpenAI ani v historických
zálohách. Na výměnu se nepoužívá nový `userId`.

Požadavek chatu má `contractVersion="cop-chat-byok-v1"`,
`billingSource="user_openai_key"`, `allowExternal=true`, `question` do 1200
znaků a volitelné `automaticContext`. Jedno UI COP může serverově zvolit
novou cestu bez druhého chatu v prohlížeči. Otázka je text napsaný
uživatelem; COP k ní nesmí potají připojit historii, dešifrované zprávy
místností ani nezveřejněná hlášení. Uživatel může sám napsat vlastní údaje,
ale Router neověří jejich autorství či právní oprávnění. COP musí zobrazit
srozumitelné upozornění na externí zpracování v režimu Global.

Automatický kontext má `contractVersion="published-context-v1"`,
`attestation="cop-published-reviewed-v1"` a 0–12 položek přesného druhu
`source_health` či `operational_metric`. Každá obsahuje povolený `sourceId`,
`publicationStatus="published"`, `originType`, `publicationRef`, `observedAt`,
`publishedAt` a budoucí `validUntil`; číselná metrika navíc omezený region,
jednotku a `sampleSize>=10`. Datum publikace nesmí být v budoucnu a platnost
nesmí překročit 30 dnů od pozorování. Router kontroluje tvar, čas a allowlist
`AI_ROUTER_PUBLISHED_SOURCE_IDS`. Pravdivost publikace, licence a toho, že
`publicationRef` patří k uvedenému zdroji, musí ověřit COP. Přepnutí modelu
nemění soukromý obsah na veřejný.

Minimální tělo požadavku jednotného chatu (podepsaná identita je výhradně v
interních hlavičkách služby COP):

```json
{
  "contractVersion": "cop-chat-byok-v1",
  "billingSource": "user_openai_key",
  "question": "Jak postupovat při výpadku proudu?",
  "allowExternal": true
}
```

COP musí zachovat přesně uživatelem napsané znění `question`. Automatický
kontext je volitelný; bez prokazatelně publikovaného zdroje se neposílá.

## Kontrakt SIM/IZS

SIM API vystavuje pouze autorizované `POST /api/v1/ai/izs-summary`.
Vyžaduje roli `SIM_IZS_ANALYST`, `approvedExternalProcessing=true` a audit
`ai.izs.summary.request`. Do Routeru předává samostatný službový token,
HMAC neprůhledný identifikátor operátora a typovaný požadavek
`sim-izs-summary-v1`. Router účtuje výhradně `sim_project`.

Pilot připouští `synthetic` se schválenými fiktivními fakty nebo
`public_aggregate` se stejně omezenými publikovanými číselnými položkami.
Citlivé skutečné incidenty, soukromá komunikace a syrová situační data sem
nepatří. Přístup IZS k vytvořenému souhrnu a jeho případné publikaci musí
mít samostatný následný pracovní tok; samotný text Routeru není ověřená
krizová událost a vždy vrací `requiresHumanReview=true`.

## Účtování, výpadky a ochrana

Nová kniha `ai_router_billing_request` odděluje `user_openai_key` a
`sim_project`. Před odesláním rezervuje konzervativní cenu, používá transakční
zámek, po odpovědi ukládá tokeny a **odhad** dolarové částky. Uživatel má
vlastní denní/měsíční strop a počet dotazů; SIM projekt vlastní strop.
Přehled `/billing-usage` je pouze pro administrátora a agregovaný přehled je
vidět v panelu SIM bez klíčů či identit. Existující globální přepínač
`externalAllowed` vypíná také obě nové větve.

Rezervace nebo databáze nedostupná před voláním znamená 503 bez kontaktu s
OpenAI. Neplatný klíč je 422, limity a 429 poskytovatele jsou 429; model či
účet nejsou nahrazeny jiným. Timeout po odeslání je `provider_outcome_unknown`:
Router drží rezervaci a nesmí automaticky opakovat požadavek, protože
poskytovatel jej mohl zpracovat a vyúčtovat. Odhad Routeru se porovnává s
OpenAI Usage/Costs ve správném projektu; odpověď výslovně nese
`actualProviderChargesVerified=false`.

Uživatelské klíče chrání AES-256-GCM a oddělený 32bytový klíč mimo databázi
a její zálohy. Pro rozpočtový audit se ukládá HMAC otisk použitého klíče, nikoli
jeho hodnota. Rotace šifrovacího klíče vyžaduje plánované přešifrování a
verzování, nikoli prosté přepsání proměnné. Smazání řádku nevymaže WAL a
starší zálohy; retenční politika záloh je provozní povinnost.

OpenAI režim Global je akceptovaná volba tohoto projektu, nikoli důkaz
nulového uchování. `store:false` nevylučuje záznamy proti zneužití. Správce
musí před aktivací zkontrolovat konkrétní projektové nastavení. Sdílení
vstupů/výstupů s OpenAI se **nezapíná automaticky**. Případný samostatný
opt-in projekt by směl obsloužit jen předem posouzené syntetické či jinak
způsobilé vstupy **i očekávané výstupy**; pozdější filtrace výstupu nezabrání
jeho již uskutečněnému sdílení. Nabídka modelu `gpt-5.4-mini` neprokazuje
bezplatné tokeny. Potvrzení vyžaduje syntetické volání a srovnání přehledů
Usage/Costs daného projektu, společně s kvalitativními testy na krizových
scénářích. Aktivace SIM/IZS navíc vyžaduje explicitní projektové ID a
schválení placeného rozpočtu.

## Akceptace a nasazení

1. Projít závazný `openapi/openapi.json` s COP; potvrdit podepisování actor
   tvrzení, registr zveřejněných zdrojů, zobrazované upozornění a přesné
   odchozí payloady. COP adaptér a jednotné UI jsou v kompetenci COP.
2. Na schváleném PostgreSQL přes HAProxy aplikovat pouze
   `deploy/ai-router/002_separate_billing.sql` migrátorským účtem. Ověřit
   tabulky/oprávnění a zálohování. Produkční tajemství nevypisovat ani
   nepřidávat do Gitu.
3. Vygenerovat oddělené HMAC a šifrovací tajemství, zřídit dedikovaný IZS
   token a ověřit projektovou identitu použitého OpenAI klíče. Stávající
   klíč lze použít pro syntetický vývoj; jako oddělený produkční projekt
   jej lze označit teprve po ověření účtu. Nastavit limity, allowlist zdrojů
   a produkční přepínače ponechat `false`.
4. Otestovat dvě různé identity/klíče, rotaci, odstranění, publikovaný i
   zamítnutý kontext, nezávislé rozpočty, výpadky, 429, nejistý timeout,
   IZS ACL a audit. Se dvěma testovacími projekty porovnat skutečné OpenAI
   Costs/Usage a redigovaný manifest odchozích polí. Nepoužívat reálné
   krizové údaje.
5. Po společné akceptaci nejprve jednotlivě povolit příslušný přepínač a
   syntetický canary. Přepnutí běžného COP chatu je samostatný release COP.

**Rollback:** přepínače obou nových větví vrátit na `false`; COP vrátí svůj
dosavadní lokální chat. Nespouštět automaticky sdílený OpenAI klíč za
uživatele. Nové tabulky a audit ponechat do vyrovnání spotřeby a doby
retence; nemazat uživatelské klíče bez výslovné politiky/migrace.

## Dosavadní ověření

Lokální testy Routeru pokrývají dvě oddělené identity/klíče, rotaci a
odstranění, nepovolený kontext a volbu účtu, šifrování, modely, denní,
měsíční a početní limit, oddělený projekt, výpadky a 429/503 bez fallbacku.
SIM API testuje oprávnění role, potvrzení externího zpracování, neprůhledné
ID operátora a audit. Sestavení, typová kontrola, testy a základní validace
OpenAPI prošly lokálně. Jde o důkazy s fiktivním poskytovatelem a databází;
neprokazují živé účtování, oprávnění konkrétního OpenAI projektu, obsah
odchozích požadavků produkčního COP ani skutečné bezplatné tokeny.
