# Driver report publication adapter — místní ověření 15. 10. 2026

Skutečně spuštěná celá sada situation-data-api: **637 PASS, 6 SKIP,
celkem 643**; 28 souborů PASS, jeden opt-in PostgreSQL soubor SKIP.
Typecheck, build, skeleton a závazné OpenAPI prošly (151 paths,
273 schemas). Celá monorepo sada ani produkční obnova neběžely.

Oproti předchozímu checkpointu 611 PASS přibylo 26 lokálních případů:
16 lifecycle wrapper, šest store interface a čtyři skutečné HTTP ordering
případy. Jsou zahrnuty v 637, nikoli další přičítané testy. Omezený
finální běh těchto tří testovacích souborů prošel 35/35. Porty, SQL pool
a response lifecycle jsou zde syntetické, kromě skutečných Express
handlerů; **žádný z těchto testů nedokazuje Root lease, skutečné PG,
nativní peer, enrollment, restore nebo produkční aktivaci**.

## Implementace a důkaz

- `driver-publication.ts` poskytuje pouze interní callback seam
  `withLease({kind}, work)` / `lease.assertCurrent()`. Produkční loader
  žádnou novou factory nepřipojuje, guarded reporty tedy zůstávají 503
  před SQL a dataset matcherem. HTTP žádnou autoritu nevybírá.
- Callback čeká na skutečné settle work promise i `finish`/`close`.
  Timeout 15 s pouze ničí HTTP response, nikdy nepředstírá SQL cancel.
  Chybějící port, vadný interface a poslední negativní check nevrátí data.
- Předčasný resolve/reject portu během odložené SQL práce zakáže pozdější
  JSON, ale nepřestane čekat na práci. Pokud JSON již začal, HTTP se
  přeruší ihned a callback dál čeká skutečné close. Neexistuje druhý zápis.
- Chyby před hlavičkami dostanou pevné 503. Chyba po odeslání/close nebo
  release chyba jen pevnou neidentifikující výstrahu, ne upstream text.
- Store kontroluje interní lease interface před i po skutečných query
  awaits. Tato lokální mechanika není zdrojem Root autority. Krátkodobý
  checkpoint admission ji nenahrazuje. Legacy před cutoverem se nemění.
- 401/400 ordering zůstává zachováno. Neplatný query ani HTTP pokus vybrat
  publication port nevyvolá SQL/matcher.

Finální helper SHA-256:
`af685e395fb593efb58c413b14043666a748be80d3b5dfdb3b61a14321a0430a`.
Finální lifecycle test SHA-256:
`05d1f06d0a26a1d8fbd15ce69c8134b6a99b93877c0aafe489edaf7c3b13010d`.
Nezávislá zdrojová kontrola stejné verze nenašla zbylý konkrétní P1/P2;
neprováděla vlastní běhy a není přičítána jako další testovací důkaz.

## Co ještě neprošlo

Skutečný Root shared/exclusive publication zámek všech destruktivních
writerů a policy/restore přechodů, retained native peer, nezávislá
quiescence, owner publisher, aktuální profily/registrace a společná
restore/replay akceptace. Zvlášť zůstává inventura dříve vytvořených
reportů/cache. Root nesmí HOLD uvolnit podle TTL nebo ztráty spojení.

Produkční image nebyl změněn. Žádný skutečný účet či měření nebyly
smazány, nesáhlo se na společnou identitu/přístup SIM a neproběhlo
OpenAI/provider volání. Testy neopravňují k samostatnému cutoveru.
Chroma reindex zůstává nedostupný kvůli odmítnutí náhradní repo identity;
nebyl obcházen ani přebudován.
