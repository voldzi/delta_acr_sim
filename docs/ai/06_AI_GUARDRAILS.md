# AI guardrails

**Status:** Baseline dokumentace

## Zakázané požadavky

- reálné bojové mise
- výběr nebo prioritizace cílů
- doporučení útoku, obrany nebo použití síly
- navádění prostředků
- optimalizace trajektorie pro zásah
- vyhýbání detekci
- hodnocení účinnosti zbraní

## Povolené požadavky

- syntetický scénář
- load test
- fault injection test
- validace konzistence
- demo scénář
- dokumentace scénáře

## Chování při odmítnutí

Systém uloží auditní záznam, zobrazí stručný důvod odmítnutí a nenabídne alternativu, která by zachovala zakázaný účel.
