# ADR 0043 — Explicitní reset známého COP scope v existujících DB

Stav: přijatý návrh a izolovaně ověřený zdroj; produkční operace neprovedena.
Datum: 2026-10-17.

## Kontext

Nový lifecycle nesmí převzít identitu či autoritu staré operace CF24.
Uživatel následně povolil odstranění testovacích uživatelských dat bez záloh;
to neopravňuje mazat jiné SIM lanes, zdroje, konfiguraci, secrets nebo
oslabovat neznámé společné ochrany.

## Rozhodnutí

Oddělený operační kontrakt `sim-clean-reset-ops-v1` má konečné COP tabulky,
predikáty a dvě souborové cache. CLI pouze plánuje. Aplikace vyžaduje vnější
Root autoritu, skutečně zastavené writery/producenty a nezávislou obnovovací
ochranu. Nezavádí veřejný endpoint ani širší runtime oprávnění.

Pevný zdrojový manifest připíná role, tabulky, RLS, triggery, funkce,
constraints, indexy a migrace. V každé existující DB proběhne reset,
náhrada přesně známých starých COP guards novými a nový enrollment v jedné
transakci. Před COMMIT se ověří autorita i absence writerů.
Neznámý/chybějící guard, cizí scope nebo nenulová legacy operace blokuje.
Idempotence platí pouze pro přesný nový a dosud nepoužitý stav.

CF24 kontrakt, soubor, otisky a historie zůstávají nedotčené. Nový enrollment
neimportuje starou operaci. Nejde o distribuovanou transakci: po částečném
neúspěchu zůstanou všichni dotčení writeři zastavení. SQL rollback vrací
vlastní transakci; reprodukovatelné cache ani testovací uživatelská data se
neobnovují. Syntetické testy nenahrazují skutečnou Root a whole-service akceptaci.

Přesný rozsah a postup: [runbook 21](../runbooks/21_CLEAN_COP_SIM_RESET_OPERATOR.md).
