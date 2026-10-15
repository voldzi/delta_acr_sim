# SQL006: omezená inventura uchovaných denních kandidátů

Skutečný izolovaný běh 15. 10. 2026, 09:13:03–09:13:04 UTC: **12/12 PASS**.
Úplný [strojový záznam](2026-10-15_DRIVER_INVENTORY_CANDIDATES_SQL.json)
má SHA-256 `b9c698eb6eb38a25517e17198849a0ca5814d8953d07c83436e4cc7f00e266c2`.

Byla použita nová soukromá PostgreSQL 18.3 instance pouze přes Unix socket,
bez TCP a produkčních credentials. Test pracoval nad skutečným schématem,
002/003/004 a novou 006. Původní záznamy testů nebyly přepsány ani přičteny.

Ověřeno:

- skutečná STABLE/SECURITY DEFINER funkce a úzká oprávnění;
- receipt bez přijatých intervalů, uložená prošlá dávka a ETA-only hash;
- dočasné i trvalé revokace včetně uložené prošlé revokace;
- pouze dodaná množina kandidátů, bez dalších hashů a privátního receipt;
- seřazení, deduplikace výstupu a skutečný vstup 4096 kandidátů;
- NULL, duplicity, vadné typy i nadlimitní vstupy;
- odmítnutí runtime/executor/PUBLIC a control mimo read-only transakci;
- skutečný binding a odmítnutí chybějícího bindingu bez jeho vytvoření;
- stejné řádky, žádný nový XID, write/advisory/tuple lock;
- odmítnutí RLS driftu místo falešné prázdné odpovědi;
- použitelné původní indexy a absence nového denního sloupce.

Přidání pouze `SELECT(owner,contributor_hash)` na ETA pro existující
NOLOGIN owner a EXECUTE nové funkce pro control skutečně změnilo privilege
fingerprint; runtime profil zůstal správný. Hodnoty v testovacím záznamu
jsou syntetické, **nejsou produkční očekávané piny**. Musí následovat jejich
nezávislé přijetí nad skutečnou instalací, ne automatická adopce z DB.

Celkový čas běhu není latence produkčního požadavku nebo zátěžový benchmark.
Neověřuje se tím skutečný účet, odvození dne, úplnost historie klíčů,
Root autorita, obnova zálohy ani produkční aktivace. Nebyla smazána žádná
skutečná data, neproběhlo provider volání. Vlastní cluster byl zastaven a
pracovní adresář odstraněn.
