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
