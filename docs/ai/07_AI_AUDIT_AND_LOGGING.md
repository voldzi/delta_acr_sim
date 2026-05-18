# AI audit and logging

**Status:** Baseline dokumentace

## Auditní položky

- requestId
- userId/role
- timestamp
- provider
- provider mode
- policy decision
- redaction summary
- schema validation result
- human review action
- draftId

## Redakce

Prompty a odpovědi se ukládají v redigované podobě. Secrets, tokeny, osobní údaje a reálná operační data nesmí být v audit logu uchována.

## Retence

Retence auditů je otevřená otázka a musí být stanovena před produkční implementací.
