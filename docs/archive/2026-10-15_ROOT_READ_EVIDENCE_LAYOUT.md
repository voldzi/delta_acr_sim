# Oddělené dočasné Root podklady pro čtení

Ověřeno 15. 10. 2026, 08:50:13–08:50:19 UTC. Výsledek: **10/10 nových
případů**, pět pro Driver a pět pro AI. Úplné piny a skutečné výsledky jsou
v [neměnném strojovém záznamu](2026-10-15_ROOT_READ_EVIDENCE_LAYOUT.json)
(SHA-256 `40c4d5870a3962d69c41076f0aa5169627d39e9abb879a17cef2b92a0534b824`).

## Co bylo spuštěno

`scripts/test-root-read-evidence-layout.mts --run --cop-source <COP checkout>`
použil samostatné Linux arm64 kontejnery s Node 24.20.0 a PostgreSQL 18.6,
skutečné Ed25519 podpisy, ověřené loopback TLS a skutečné SQL readerů.
Privátní `/run/cop-account-safety/private` byl explicitní Root-only 0700
tmpfs. Nebyly použity externí síť, host bind mount, volume, veřejný port,
stažení/sestavení obrazu, provider ani produkční přístup.

Každý reader prošel těmito novými kontrolami:

1. Platné podklady a permit v nových privátních cestách umožní čtení.
2. Platná evidence pouze ve starém trvalém adresáři nestačí.
3. Trvalá kopie nezachrání poškozenou dočasnou evidenci.
4. Nevyhovující práva souboru nebo symlink jsou odmítnuty.
5. Starý trvalý permit nenahradí chybějící dočasný permit.

Před i po každém případu byly stejné skutečné cílové a registry řádky.
Sentinel trvalého mutation adresáře zůstal beze změny. Všechny vlastní
testovací kontejnery, jejich případné implicitní volumes a pracovní staging
byly odstraněny; nebyl použit globální prune.

## Přesný rozsah důkazu

Zmrazené předchozí Driver 16 a AI 14 testy ani jejich záznamy nebyly
upraveny, znovu spuštěny nebo přičteny. Nový harness vznikl kontrolovanou
mechanickou derivací pouze jejich bootstrapu a úklidu. Strojový záznam
obsahuje piny původních vstupů, nových readerů, runneru i derivace.

Syntetický peer není kernelové ověření. Tento běh neověřuje společnou
Root owner autoritu, zpracování mutation/ACK, native transport, enrollment,
obnovu zálohy, instalaci ani produkční aktivaci. Produkční data a účty se
nezměnily; `wholeAccountComplete` zůstává `false`.
