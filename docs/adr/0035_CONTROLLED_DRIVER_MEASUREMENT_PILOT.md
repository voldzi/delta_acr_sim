# ADR 0035: řízený pilot Jízdy a oddělená rotace službového tokenu

Status: accepted for controlled deployment; physical iPhone acceptance pending.
Date: 2026-10-11.

## Rozhodnutí

Uživatel schválil výměnu službového tokenu COP–SIM a zapnutí dobrovolného
pilotního příjmu pro ověření. Tím se mění dřívější podmínka, že produkční
příjem zůstává vypnutý až do fyzické akceptace: omezený pilot ji nyní umožní
provést. Nejde o souhlas s plošným sběrem ani zapojením do navigace.

- REST kontrakt zůstává `sim-driver-measurements-v1`.
- SIM nadále vrací výhradně `shadow_only`; souhrny nevstupují do živých
  rychlostí, `traffic.tar`, výběru trasy ani ETA.
- COP omezuje grant a nové dávky na serverový allowlist ověřeného OIDC `sub`.
  Identitu klientského pole, přihlašovacího jména či e-mailu nebere jako důkaz.
  Prázdný/neplatný pilotní seznam musí příjem odmítnout.
- Příslušnost do pilotu nenahrazuje samostatný dobrovolný souhlas.
- Čtení stavu, odvolání a mazání uchovaných příspěvků se nesmějí blokovat
  nepříslušností do pilotu ani vypnutím příjmu.
- Rotuje se pouze oddělený bearer `COP_DRIVER_MEASUREMENTS_SIM_TOKEN` /
  `DRIVER_MEASUREMENTS_COP_TOKEN`. Obě HMAC identity zůstávají beze změny,
  protože určují vyhledání, deduplikaci a smazání starších příspěvků.

## Akceptace a návrat

Nejdříve rotace při obou intake flags `false`: starý token 401, nový token
autorizuje přísnou validaci, předrotační syntetický příspěvek lze smazat,
FK cascade a tombstone jsou potvrzené. Teprve poté příjem SIM a allowlist COP.

Fyzické ověření na iPhonu musí doložit souhlas, minimalizaci, outbox/retry,
idempotenci a souběh dávky/odvolání. COP 202 stále znamená čekající smazání.
Jednoho testujícího řidiče nelze vydávat za veřejný agregát ani nezávislý
důkaz přesnosti ETA; minimální agregační prahy zůstávají zachované.

Rollback vypíná oba příjmy, zachovává SIM revocation-only, COP cleanup,
nový token, DB a HMAC. Nikdy neobnovuje původní kompromitovaný bearer nebo
historickou DB. Zálohy mají oddělenou politiku a obnovovací karanténu.

Podrobný postup: [runbook 17](../runbooks/17_DRIVER_MEASUREMENTS_PRODUCTION.md).
