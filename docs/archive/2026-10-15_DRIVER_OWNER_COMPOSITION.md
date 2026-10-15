# Driver owner composition — místní ověření 15. 10. 2026

Skutečně spuštěná celá SDA sada: **611 PASS, 6 SKIP, celkem 617**,
27 testovacích souborů prošlo a jeden opt-in PostgreSQL soubor byl
přeskočen. Prošly typecheck, build a OpenAPI validace (151 paths,
273 schemas). Celá monorepo sada ani fyzická produkční obnova se v tomto
kroku nespouštěly.

Čtyřicet nových lokálních případů pokrývá pevnou owner kompozici,
custody před importem, CLI, HTTP ordering a publication-denial. Jsou
součástí 611, nikoli další přičítané testy. Porty, filesystem a storage
jsou v nich syntetické; neověřují Root podpis, native peer nebo skutečné
SQL. Starší samostatné Root/PostgreSQL receipts zůstávají oddělené.

## Co se změnilo a ověřilo

- Production SDA entrypoint načítá pouze čtyři pevné COP factories z
  `/opt/cop-account-safety` po ověření Root-owned ordinary closure.
  Chybějící část znamená `guarded:{}`, bez legacy DML fallbacku.
- Jen přesný POST erasure a DELETE revoke dostanou lokální šestipolový
  scope; GPS batch, GET, preflight ani jiné metody se nepředají.
  Souběžné lokální ALS kontexty jsou oddělené, ale nejsou vydávány za
  Root lease nebo drain.
- Skutečné Express handlery zachovávají 401 bez tokenu, 400 pro vadné
  vstupy a 503 pro platnou mutaci bez chráněného kontextu, před SQL.
  Samostatný nezávislý health endpoint fungoval.
- Standalone úklid používá stejný loader/guarded porty/maintenance
  consumer. Bez consumeru nečte konfiguraci a nevytvoří pool. Init,
  cleanup i close se awaitují; při chybě není druhý dispatch nebo vlastní
  cutoff/nový origin.
- Guarded `aggregates` a `quality` nově vracejí 503 před SQL. Tím se
  uzavírá dřívější raw-read bypass při obnově. Ani kladný krátkodobý
  read-admission stub není považován za held publication bariéru.
  Původní legacy režim před koordinovaným cutoverem se nemění.

## Otevřená skutečná akceptace

COP musí dodat a společně přijmout skutečné factory bytes, nativní
publisher/current context, maintenance lifecycle, read/publication lease,
report inventory i obnovu/replay. Pevné názvy modulů a unit porty je
nevytvářejí. Zvlášť musí projít ochrana dříve vygenerovaných souborů,
nikoli jen nové API dotazy. OpenAPI popisuje 503 guarded reportů.

Produkční obraz nebyl změněn, žádné skutečné účty nebo měření nebyly
smazány a neproběhlo OpenAI/provider volání. Nový image se nesmí
aktivovat jen na základě tohoto místního výsledku.
