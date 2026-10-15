# Ověření privátního read-only stavu měření

15. 10. 2026 v 06:53:32–06:53:33 UTC prošlo **14 samostatných
PostgreSQL 18.3 případů**. Běh použil nový soukromý místní cluster bez TCP,
skutečné schema/002/003/004, omezené role a skutečné katalogové granty.
Po úspěchu odstranil pouze svůj zastavený syntetický cluster.

[Strojový záznam](2026-10-15_DRIVER_READ_ADMISSION_SQL.json) obsahuje
všechny případy, přesné piny i hash skutečně spuštěného runneru před/po.
SQL004 má SHA-256
`791545b9df91e65bb555c68a44dadd73a847ca64fde0c31a9036f9f555ba1d2d`;
runner `a84618b475c1f3707941e2290982a6069a4888461eea3f0a10fc5e6305e98e5f`.
Zmrazené důkazy 18/11 byly pouze porovnány, ne spuštěny, přepsány
nebo přičteny.

Ověřeno je pět přesných účelů, actor-bound projekce, nepřítomnost
identity na owner-wide reads, odmítnutí neznámých klíčů a chybějícího
READ ONLY, zákaz EXECUTE runtime/executor a skutečná inkarnace i stav.
Drift triggeru, PUBLIC column grantu, členství nebo TEMP mění fingerprint
a blokuje ready profil. Čtení nečeká na contributor/state row locks,
nezíská write/advisory lock a nezmění ledger, fences, receipts ani
připravený origin. Chybějící nebo odebraná funkce je nedostupná.

Výsledek potvrzuje SQL pozorování a izolaci, ne skutečný Root podpis,
peer/enrollment, deployment, restore nebo mazání účtu. Čistý validator
má oddělených sedm syntetických Node testů; jejich počet se k SQL ani
produkční akceptaci nepřičítá.
