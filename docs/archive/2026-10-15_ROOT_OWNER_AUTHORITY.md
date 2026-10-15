# Společná pevná Root owner autorita — izolované ověření

Skutečný běh hlavního SIM agenta 15. 10. 2026, 09:45:45–09:46:13 UTC:
**22/22 PASS**. [Úplný neměnný záznam](2026-10-15_ROOT_OWNER_AUTHORITY.json)
má SHA-256 `a88fa4788a9e0fa6fb3265310e7f3038282cfa417ce45311ce092a7413b3f49a`.
Předchozí dílčí záznamy nebyly přepsány nebo přičteny.

## Skutečně provedený běh

Nový runner `scripts/test-root-owner-authority.mts` spustil jediný skutečný
Root proces v samostatném Linux arm64 kontejneru. Použil Node 24.20.0,
PostgreSQL 18.6, skutečný nepřepsaný `pg`, Ed25519 podpisy, kompaktní JWS,
ověřené TLS a session advisory zámky guard databáze 904214. Metadata jsou
skutečné připnuté migrace 001 a úzký reader 002, cíle skutečné Driver
schema/002–006 a AI 001–005.

Připnutý nativní addon `283f528f6ffce67c46e180a8a7ddcf215c1588dd579cbf36ca507b8896802d20`
poskytl skutečnou vlastní pidfd identitu. Start ticks, executable hash a
boot běžícího Root procesu byly skutečné. Aplikační peer tuple, přijímací
metadata, politiky, klíče, certifikáty a ostatní host/container pozorování
byly **syntetické**. Skutečný host watcher ani native packet transport se
tímto během neověřují. Syntetická administrátorská příprava byla oddělena
od skutečné omezené reader role; žádný testový callback, PG stub,
membership nebo RLS bypass nepřidával autoritu common modulu.

Nebyla použita externí síť, host bind mount, persistentní volume, veřejný
port, image pull/build, produkční credentials, reálný účet ani provider.
Soukromé read podklady byly na explicitním Root-only 0700 tmpfs.

## Doložené hranice

- Platné obě owner cesty a společné skutečné registry/SQL/crypto ověření.
- Souběžné sdílené zámky blokují writer až do obou známých ukončení;
  exkluzivní zámek odmítá reader i další writer.
- Expirace oprávnění odmítne práci, ale sama neuvolní zámek. Explicitní
  potvrzené ukončení jej uvolní; nejde o automatické TTL odemčení.
- Neměnný původní intent přežije vlastní deadline beze změny bajtů,
  data souboru, těla, UUID nebo podpisu.
- Oba read pluginy vydávají čerstvé typované podklady; přesun platné
  evidence do trvalého adresáře nezachrání chybějící dočasný podklad.
- Odmítá se jiný deklarovaný aplikační peer, vadný podpis, frontier/boot
  mismatch, skutečný schema/privilege drift, záměna policy nebo keyringu,
  prošlý host záznam, vadné row digests, cizí receipt a starší acceptance.
- **Správně podepsaný a ještě platný 5s host záznam jiné Root instance**
  selže přesně `GUARD_OWNER_BROKER_RESTARTED`; skutečná vlastní identita
  běžícího procesu přitom zůstala nedotčena.
- P0/P1 mohou mít různá proof ID, ale odlišný `ownerPolicyRef` zůstává
  odmítnut. Žádné neschválené přijetí historické politiky nebylo přidáno.
- Poslední případ skutečně ukončil metadata backend. PostgreSQL zámek
  poté již nebyl držen, ale common zachoval process-global HOLD a
  odmítl dalšího ownera. Nikde se HOLD neresetoval kvůli dalšímu testu.

Před a po read/negative skupinách byly skutečné cílové a registry řádky
stejné. Výslovný expiry případ navíc vložil pouze nový source proof.
Fixture administrativně vytvářela negativní odchylky a poté obnovila
původní syntetické schéma/práva; common je sám neopravoval ani neadoptoval.

Dva předchozí pokusy neprošly bootstrapem a nevytvořily PASS záznam.
Druhý bezpečně lokalizoval PostgreSQL `42P08` v testovacím INSERTu:
jeden parametr byl současně použit jako UUID a text. Opraveno bylo pouze
explicitní přetypování ve fixture, nikoli databázová nebo autorizační
kontrola aplikace.

Všechny vlastní kontejnery a staging úspěšného běhu byly odstraněny;
globální prune nebyl použit. Ukončení jednorázového procesu po posledním
HOLD **není přijetí obnovy** nebo důkaz produkční quiescence.

## Přesné omezení výsledku a navazující ověření

Tento běh není SQL005 checkpoint writer integrace, ztracený COMMIT,
neznámý konec cílové session, skutečný host/native transport, úplná
inventarizace účtu, produkční enrollment, restore ani deployment.
Připnutý COP mutation executor dosud není tímto testem propojen se
společným exkluzivním zámkem. `requirePublicationBarrier` a samostatný
checkpoint writer zde nemají pozitivní integrační akceptaci.

Před nasazením musí společný COP–SIM test pokrýt skutečné executory,
read/publication drain, recovery stejného originu a nezávislou startup/
publish karanténu starého či obnoveného obrazu. Kořenová služba a nové
role/profily/politiky nejsou instalované do produkce. `productionChanged`,
`productionEnrollment`, `restoreAccepted` a `wholeAccountComplete`
zůstávají `false`.

Po tomto běhu místně prošly také `pnpm typecheck`, `pnpm test` (843 PASS,
6 volitelných PostgreSQL případů SKIP), `pnpm build`, skeleton a závazný
OpenAPI kontrakt (151 cest, 274 schémat). Webový test script je pouze
deklarace smoke testu; tyto příkazy nedokládají aktuální browser akceptaci.

Aktivní kontrakt a gates jsou v [integraci 23](../integration/23_SIM_ACCOUNT_SAFETY_RUNTIME_PREPARATION.md)
a [runbooku 19](../runbooks/19_COP_ACCOUNT_ERASURE_PRODUCTION.md).
