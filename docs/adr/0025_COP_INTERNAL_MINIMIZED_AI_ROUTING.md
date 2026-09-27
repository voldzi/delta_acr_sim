# ADR 0025: Minimalizovaný interní kontext pro externí COP chat

**Rozhodnutí 27. 9. 2026:** SIM AI Router rozšiřuje připravený kontrakt COP
o `internal_minimized` podle COP commitu `623927f` a COP ADR 0030. Nejde o
automatickou reklasifikaci stávajícího chatu `internal` ani o jeho přepnutí.

## Rozhodnutí

Pouze službová identita COP smí pro `taskType=cop_chat` předat stabilní
neprůhledné `userId`, předem zkontrolovanou otázku nejvýše 1200 znaků,
`preference=external`, `allowExternal=true`, `allowPaidEscalation=false` a
`copContext` verze `cop-chat-context-v1` s třídou `internal_minimized` a
atestací `cop-internal-minimized-reviewed-v1`. `items` má 0–12 položek a
přesně dvě možné struktury: `source_health` (`sourceId`, stav
`up|degraded|down`) nebo `operational_metric` (`metricId`, stát/kraj,
konečná číselná hodnota, schválená jednotka, alespoň 10 vzorků). Žádné další
klíče, textové položky ani volný kontext nejsou přípustné.

Router pro tuto třídu připustí pouze `gpt-6-luna` na ekonomickém tieru.
Konfigurace jiného ekonomického modelu skončí 503. Platí stejná transakční
rezervace denního a měsíčního finančního limitu, uživatelský denní limit a
audit tokenů i odhadované ceny jako pro ostatní externí požadavky.
Překročení limitu a omezení rychlosti u OpenAI vrací 429; výpadek databáze
nebo modelu vrací 503 bez dalšího modelového volání. Stávající `internal` zůstává pouze na
lokálním modelu; `synthetic` a `public_aggregate` zůstávají oddělené třídy.

Provozní schopnost `AI_ROUTER_COP_INTERNAL_MINIMIZED_ENABLED` je výchozím
nastavením vypnutá i při globálně povoleném externím tieru. Její zapnutí,
změna sítě/tokenů a přepnutí běžného COP chatu jsou oddělené kroky po
společné akceptaci. Tato změna žádný z nich sama neprovádí.

## Hranice odpovědnosti

Router ověřuje tvar, typy, klíče, délky, shodu třídy, atestaci, službovou
identitu, souhlas, model, limity a audit. Neověřuje sémantickou pravdivost
otázky nebo původ zdrojových dat. COP musí sestavit kontext pouze z
vyjmenovaných, zkontrolovaných polí. Dešifrované soukromé zprávy, osobní
údaje, citlivé incidenty, syrové situační záznamy, přílohy, partnerská
neveřejná data a volný `chatContext` se do třídy nevejdou. Atestace je
prohlášení důvěryhodného COP kódu, nikoli důkaz absence osobních údajů.

Před produkčním zapnutím je nutné pro konkrétní OpenAI API projekt ověřit
zpracovatelský vztah, nastavení uchování, schválení případného režimu
Modified Abuse Monitoring/Zero Data Retention, dostupnost `gpt-6-luna` a
požadovanou regionální konfiguraci. Podle
[oficiálních pravidel OpenAI](https://developers.openai.com/api/docs/guides/your-data)
`store:false` samo o sobě nevypíná všechny provozní logy; evropská
rezidence má další projektové a smluvní podmínky. Dokud nejsou doloženy,
nový přepínač zůstane vypnutý.

## Návrat

Před aktivací není třeba měnit COP. Při pozdějším problému se nejprve vypne
COP volba této větve, pak `AI_ROUTER_COP_INTERNAL_MINIMIZED_ENABLED`; ostatní
třídy, lokální chat, rozpočtová databáze i audit zůstávají zachovány.
