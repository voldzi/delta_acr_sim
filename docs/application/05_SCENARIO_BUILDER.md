# Scenario builder

**Status:** Baseline dokumentace

## Funkce

- Vytvoření a editace scénáře.
- Výběr geografické oblasti, délky, seed a update rate.
- Výběr povolených simulačních bloků.
- Nastavení object count a patternů pro každý blok.
- Validace proti `scenario.schema.json` a `scenario-block.schema.json`.
- Uložení jako draft nebo template.

## Bezpečnost

Builder nesmí obsahovat pole nebo workflow pro cíle, účinky, navádění, zbraňové parametry nebo taktické doporučení.
