# Ověření koordinovaných guarded driver SQL operací

Místní PostgreSQL 18.3 ověření dne 15. 10. 2026 prošlo **18/18 nových
případů**. Běh 05:10:09–05:10:12 UTC používal skutečné nezměněné driver
tabulky, receipt guard a cascades z původního schématu a migrace 002.
[Strojový záznam](2026-10-15_DRIVER_GUARDED_OPERATIONS_SQL.json) obsahuje
všechny případy a přesné piny. Jeho SHA-256 je
`80ea5fb1a4e914a5439dba901bfee528c1136c1ed812aee9c7bfb82ebe869c42`.

## Připnuté vstupy

| Vstup | SHA-256 |
| --- | --- |
| `deploy/driver-measurements/003_guarded_operations.sql` | `e3513a983a3b6d1bd52d46851c734dd1c3b208e2e2f6430a6f9eddd38b10d3b5` |
| `deploy/driver-measurements/guarded-runtime-verification.sql` | `3ef5ad53b2e4f94d143636e7bf2e26108fd10d3d34c2a0521ca4760d95ca88a2` |
| `scripts/test-driver-guarded-operations-postgres.mts` | `547c0486f7a902c6bd4b920139b50178de392f2b3f91f27f3b1d177becf80e97` |
| `scripts/provision-driver-measurements-postgres.sh` | `d985b7f5b62b4c858659fc8cf6625867b07fff0b3720a73c9e83e19613220eee` |
| `scripts/test-driver-provisioning-guard.mjs` | `d978dbbd22884173c9e18e0b2c802b94bcc7ce94cb7f0ad680918daf10a926cf` |

Starší 11-case expiry source, harness a receipt zůstaly přesně beze změny;
jejich piny jsou i v novém JSON. Jejich výsledky, starší lifecycle a COP
testy se k osmnácti novým případům nepřičítají.

## Izolace a výsledek

Test vytvořil vlastní nový cluster v soukromém adresáři se socketem 0700,
bez TCP listeneru. Nepřijímá cílovou URL ani skutečné přístupy. Všechna
data a lokální role byly syntetické. Žádný provider, OpenAI, Docker,
produkční databáze, síť, token nebo skutečný účet se nepoužil ani nezměnil.
Úspěšný cluster se zastavil a odstranil. SQL vstupy i spouštěný harness
měly stejný hash před bootstrapem a po testech. Node 24.16.0; samostatná
přísná TypeScript kontrola prošla.

Ověřen je úzký runtime profil, zákaz přímého DELETE a změny expiry,
chybějící/odmítnuté funkce bez falešného odvolání souhlasu, detekce
table-level i PUBLIC column driftu a TEMP práv. Expirace/cascade/marker
sdílejí původní transakci. Claim nelze přenést do jiného XID; seal musí být
skutečně commitnutý. Přesné neznámé klíče, body a origin konflikty jsou
odmítnuté před efektem.

Skutečné souběžné spojení prokázalo čekání revoke na intake zámek a následné
odstranění právě commitnutého cílového příspěvku při zachování jiného.
Sedmidenní revokace začíná až po získání zámku. Erase zachovává původní
actor/request/acceptedAt a součty, odmítá neúplný manifest, čte gate až po
contributor zámcích a drží ji přes efekty a COMMIT. Permanentní fence
odmítla souběžný pozdní intake přes skutečný receipt trigger.

Publication readback je control-only, read-only a vázaný na commitnutý
erase origin. Typovaný syntetický ACK funguje pouze v původní transakci;
neznámé klíče, jiný store, digest, report policy, čas, ledger nebo fences
jej odmítnou. Bez kontextu zůstává ACK pending bez změny ledgeru a nesnižuje
už potvrzený stav. Origin journal nevytváří novou vazbu účet/den/contributor.

Samostatných **5/5 offline provisioning testů** prošlo při úplném zachycení
všech psql volání: guarded apply/recover odmítá změny, check používá pevný
čtecí verifier, neúspěch nepřechází na legacy grants a původní check
zůstává čtecí. Nevznikl soubor přístupů a nebylo voláno skutečné PostgreSQL.
Nejde o dalších pět databázových případů.

Čtecí revize finálních pinů nenašla zbývající P1/P2 ve vymezeném SQL,
verifieru a provisioning změně. Dvě nalezené mezery byly opravené před
jediným tímto novým PG během: účinné PUBLIC column granty a revokační
expiry od začátku čekající transakce. Revize není druhý běh testů.

Shell syntax, samostatný přísný TypeScript check, skeleton, OpenAPI sanity
(151 cest, 273 schémat) a diff check prošly. Celý workspace build/test se
kvůli této privátní SQL změně znovu nespouštěl; žádný aplikační TypeScript
nebo HTTP kontrakt se nemění. Pokus o Chroma reindex byl odmítnut kvůli
náhradní repository identity; tuto hranici jsme neobcházeli a index se
nepřestavoval.

## Co tento výsledek nedokazuje

Privátní fixture control registruje syntetické operace a publication
kontext; neověřuje skutečný Root podpis, přijaté registry/evidence,
aktuální frontier, report inventory, delivery nebo restore. Všechny
odpovídající `actual` příznaky ve strojovém záznamu zůstávají false.
SQL digest ani úspěšný marker není authority. `wholeAccountComplete=false`.

Nové SQL není samo aplikační consumer nebo přijaté produkční oprávnění.
Nasazení musí současně zapojit skutečného chráněného vykonavatele,
retenci, revoke/erase/ACK writery a zúžené granty. Samostatná aplikace 003
na živou databázi před touto akceptací by porušila funkčnost legitimního
mazání. Produkční obrazy, flags, granty a přístupy se tímto krokem neměnily.
Závazný OpenAPI ani veřejné endpointy se neměnily.
