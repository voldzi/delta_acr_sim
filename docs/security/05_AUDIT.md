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
