# DBv2: akceptace mazání COP/Jízdy

Aktivní zdrojová cesta je [ADR0040](../adr/0040_DATABASE_BACKED_ACCOUNT_ERASURE.md).
Produkční aktivace není doložená. Root/native instalace není její podmínkou.
REST `sim-account-erasure-v1`, identity SIM/IZS a finanční retence se nemění.

## Přesné soubory a konfigurace

- Driver: původní schéma + SQL002 a povinná
  `008_eta_contributor_binding_database_v2.sql`. ETA/parent mismatch končí
  23514 bez opravy dat; Root003–006 se kvůli tomu neinstaluje.
- AI: SQL001–003; rezervace `reserved`/`uncertain` zůstávají pending.
- Nezávislá DB `cop_account_safety_guard`: SIM migrace
  `010_sim_database_safety_v2.sql`; legacy COP tabulky se nemění.
- Oba targety: `011_sim_target_binding.sql`, explicitní admin enrollment
  shodných config/store/incarnation/checkpoint/generation, runtime SELECT-only.
- Explicitní mód `SIM_ACCOUNT_ERASURE_AUTHORITY_MODE=database_v2`.
  Default `root_native_v1` se nemění; selhání nemá automatický fallback.
- Dvě oddělené secrets URL `DRIVER_ERASURE_GUARD_DATABASE_URL` a
  `AI_ROUTER_ERASURE_GUARD_DATABASE_URL`; Compose je předá odpovídající
  službě jako `SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL`. Nesenzitivní piny:
  `SIM_ACCOUNT_ERASURE_GUARD_STORE_ID`, `SIM_ACCOUNT_ERASURE_CONFIGURATION_FINGERPRINT`.

Driver env checkpoint je přesný přijatý UUID; SQL002 používá jeho stávající
HMAC. AI checkpoint/generation odpovídají guard vazbě. Oba erasure flags
při přípravě false; příjem Jízdy a `shadow_only` se nemění. Pokud již byl
instalován Root guarded SQL s jinými právy, samotný env přepínač nestačí.

## Skutečné ověření

Loadery před listen replaynou všechny vlastní tombstones do skutečných
target fences. Journal COMMIT předchází target změně; nejistota se řeší
lookupem stejného operation ID, ne novou operací. Žádný true callback.

`scripts/test-database-erasure-http.mts --run <port>` přijímá jen vlastněný
lokální cluster `cop_erasure_owned_test` a odmítne přepsat existující DB.
`--serve-existing <port>` ověří fixture fingerprint a spustí skutečné HTTP
služby pro COP test; private JSON má mode600 a pouze syntetické údaje.
Ověřit celý COP controller → HTTP → PG, auth/invalid/limit/outage, idempotenci,
batch/delete race, ETA cizího parentu, 202→settlement→200, B/SIM preservation
a restart/replay. Jiný chybějící povinný owner ponechá celý COP účet pending.

## Před produkcí a návratem

HTTP reporty drží skutečný sdílený PG zámek do ukončení odpovědi; delete
a barrier mají exkluzivní protějšek. Externí souborové exportery/cache
nutno inventarizovat a zastavit/invalidovat nebo zapojit do téže ochrany.
HTTP ochrana neprokazuje bezpečnost cizího writeru; nelze tvrdit `no_report`.

Před obnovou zastavit služby i expozici. Guard neobnovovat se starým app
snapshotem; přijmout novou incarnation/generation, izolovaně replaynout,
ověřit a teprve poté zpřístupnit. Při obnově celého clusteru obnovit nejnovější
nezávislý guard backup/WAL bez mezer; nejistota znamená karanténu. Starý
image bez replay se nevrací. Lokální test není fyzická obnova PBS.

Návrat zakáže nové operace, nikoli přijaté fences/retry/replay. Nemazat
journal ani nevytvářet prázdný namespace. Produkční secrets, granty a
obrazy se mění až po společné akceptaci, bez změny veřejných portů/sítě.
