# Audit

**Status:** Baseline dokumentace

## Auditované události

- vytvoření a změna scénáře
- runtime commands
- fault injection changes
- publisher config changes
- queue retry/clear/DLQ operations
- AI prompt policy decision
- AI draft accept/reject
- auth failures

## Minimální pole

- auditId
- timestamp
- actor
- role
- action
- resourceType
- resourceId
- correlationId
- result
- redactionApplied

## Integrita

Audit log má být append-only nebo minimálně chráněný proti běžné editaci v aplikaci. Retence je otevřená otázka.

## Evidence AI Routeru

Oddělená PostgreSQL evidence ukládá klienta (`cop`/`sim`), hash stabilního
uživatelského ID, typ úlohy, model, důvod směrování, rezervovaný a odhadovaný
účtovaný náklad, vstupní a výstupní tokeny a stav. Neukládá prompt, kontext,
plaintext uživatelské ID ani API klíč. Denní/měsíční součty v SIM zahrnují
jen volání přes Router; nejsou fakturou ani součtem přímých volání COP mimo
Router. Pokud po odpovědi modelu selže zápis výsledku do evidence, Router
vrací 503 a neoznačí požadavek jako úspěšný.

Nové oddělené cesty vedou další knihu `ai_router_billing_request` s typem
plátce, HMAC otiskem použitého klíče, neprůhlednými hashi plátce/aktéra,
rezervací, stavem, modelem a tokeny; částka je jen odhad. Správa klíče má
oddělený audit změn bez hodnot klíčů. SIM/IZS proxy vyžaduje
`SIM_IZS_ANALYST` a zapisuje `ai.izs.summary.request`; samotný text souhrnu
ani vstupní fakta se do rozpočtové knihy neukládají. Při nejistém výsledku
provider volání zůstává rezervace pro následné vyrovnání.

## Dočasná interní diagnostika routování

`routing_guard_diagnostic_v1` je provozní diagnostika, nikoli audit oprávnění
k vjezdu. Výchozí stav je vypnutý. Samostatně schválená konfigurace omezí okno
na nejvýše deset minut a šestnáct chybných požadavků na proces. Korelace je jen
validní požadavkové UUID dodané COP, nikdy ID účtu nebo auta. Nezapisují se
polohy, těla, štítky, hodnoty profilu, identifikátory uživatelů, hlavičky
oprávnění, tajemství ani volný text poskytovatele. Výstup má pevný seznam polí
a číselné limity v [provozním kontraktu](../runbooks/13_PERFORMANCE_OPERATIONS.md).
Pole algoritmu a důvodu druhého průchodu jsou výslovně `not_reported`.

Události zůstávají pouze v existujícím interním provozním logu; nevzniká nová DB,
veřejný diagnostický endpoint ani export soukromých požadavků. Expirace ukončí
nové záznamy, **nemaže již zapsané logy**. Jejich existující infrastrukturní
retenci a oprávnění musí Root ověřit před aktivací; tento zdroj neurčuje novou
nekonečnou retenci. Čtěte pouze konkrétní korelovanou allowlist událost. Veřejná
chyba ani ochranné rozhodnutí se zapnutím diagnostiky nemění.
