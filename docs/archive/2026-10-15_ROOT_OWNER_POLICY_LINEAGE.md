# Ověření návaznosti podepsaných politik kontrolního bodu

Samostatný běh hlavního SIM agenta 15. 10. 2026 v 10:43:48–10:44:24 UTC
prošel **8/8 skupinami**. [Neměnný strojový záznam](2026-10-15_ROOT_OWNER_POLICY_LINEAGE.json)
má SHA-256 `6691948fc7e2393de9147b7f9c543e030482f1eaf0c9e9af25e2ab095685e168`.
Tento výsledek nenahrazuje ani nerozšiřuje starší common 22/22 nebo COP
native writer 4/4 důkazy; ty patří svým původním připnutým kompozicím.

## Skutečný průběh

Nový runner mechanicky převzal pouze bootstrap ze dvou neměnných,
hashově ověřených starších testovacích souborů. Staré scénáře nespouštěl
a staré záznamy nepřepsal. Záznam obsahuje piny původních i odvozených
zdrojů, skutečně spuštěného odvozeného runneru a přesného dependency closure.

Použit byl skutečný Node 24.20.0, PostgreSQL 18.6, neupravený `pg`,
ověřené TLS, Ed25519/JWS, Root custody a skutečné guard session zámky
904214. Nativní addon poskytl skutečnou vlastní pidfd identitu; vlastní
start ticks, executable hash a boot byly skutečné. Aplikační peer,
host/container fakta, nezávislé schválení politik, certifikáty a metadata
enrollment byly syntetické. Skutečný host observer ani native packet
transport tento běh neověřoval.

Checkpoint writer skutečně zavolal Driver SQL005 dvakrát a AI SQL005
jednou. Archiv politiky vznikl ve skutečném commonu před intentem/setterem,
nikoli kopírováním ve fixture. Nové C2/C3 byly administrativně přijaté
syntetické podklady nad skutečným neměnným metadata SQL001 a jeho triggery;
produkční publisher je tento běh nevytvářel. Jejich zdroj P0t byl od začátku
samostatná podepsaná operace `deployment`. Následné aktuální P1 byly
obyčejný `refresh`, který se nestal replay oprávněním.

## Osm ověřených skupin

1. Shodná P0/P1 policy reference funguje pro oba ownery; read kontext ani
   kopie WeakMap kontextu nesmí archivovat politiku.
2. Vypršený aktivní Driver target a koherentní karanténa odmítnou běžné
   čtení. Předem podepsaný opravný publisher projde; skutečný writer provede
   A na B a následný samostatně podepsaný B na C. Common přijme C2/C3 pouze
   přes přesnou historii a původní dispatch. První operace se neobnovuje.
3. AI skutečný writer přejde z textové generace `9007199254740992` na
   `9007199254740993`, beze ztráty přesnosti. To je cílová AI generace;
   metadata acceptance generace jsou odděleně 1 a 2.
4. Chybějící, padělaná či nechráněná historie se odmítne. Skutečný common
   odmítne také chybějící nebo kryptograficky poškozený původní C1 artefakt.
5. Jiná inkarnace, evidence/piny a procesní kohorta zůstanou odmítnuté.
6. Změněný původní přechod, intent nebo dispatch neprojde ověřením.
7. I platná historie nestačí při skutečně nesprávném cílovém Driver či AI
   checkpointu; ověřeny jsou konkrétní policy-match chyby obou readerů.
8. Po expiraci zůstávají originály, podpisy, bajty i časy artefaktů stejné.
   Aktuální AI P1 může navázat na historickou řádnou C2; Driver target s
   prošlým skutečným proofem zůstává pro běžné čtení odmítnutý.

Před a po skupinách se porovnávaly skutečné PG row digesty. Změnit se
směly jen výslovně vyjmenované syntetické přechodové metadata/state
tabulky; žádná měření, klíče, účetní historie ani finanční součty se neměnily.
Nebyl použit PG stub nebo dodaná kladná autorizační funkce.

První pokus nevytvořil PASS záznam: skutečné metadata SQL odmítlo
`refresh` jako replay operaci (`23514`). Opravena byla pouze chybná
syntetická příprava na samostatný schválený checkpoint `deployment`.
Databázové omezení, podpisové ani autorizační kontroly zůstaly beze změny.

## Piny a rozsah

- Common: `b592e1e26768d70c8fca1d699caba6007e5b40a071fe8326beccf51df8a0b7ca`.
- Writer: `1ed0946027261d7111a84b7f2e8633e424301f5b34f9cc210f9866a634017304`.
- Helper historie: `c918139370a8782c2605d5957d7c79e2e5cacc1e31ac9d519d11e208a4bfcd44`.
- Nový zdrojový runner: `497b776b480ab3b04933762aa082b8d573cf3476935927ce308408a07393f3d0`.
- Nové scénáře: `82b3135dc85e5ba05b38fb0968e7524a73192849ec7d9d8f1ed1deb37dd253bf`.

Všechny vlastní kontejnery a úspěšné staging adresáře byly odstraněny.
Žádná externí síť, veřejný port, bind mount, persistentní volume,
image pull/build, skutečný účet, produkční credential ani provider
se nepoužil. Produkční služby, databáze a příznaky se nezměnily.

Výsledek neprokazuje neznámý konec cílové session, ztracený COMMIT,
skutečné vydávání aktuálních source proofů/politik, nativní delivery,
enrollment, produkční nasazení ani obnovu po HOLD/záloze. Prvotní Driver
historie z nulového checkpointu zůstává odmítnutá. Samostatné společné
ověření vyžaduje skutečný producer, runtime a nezávislou startup/publish
karanténu starého či obnoveného obrazu.

Závazné soukromé ABI a podmínky aktivace jsou v
[integraci 23](../integration/23_SIM_ACCOUNT_SAFETY_RUNTIME_PREPARATION.md)
a [runbooku 19](../runbooks/19_COP_ACCOUNT_ERASURE_PRODUCTION.md).

Po novém běhu prošly typové kontroly, sestavení a aplikační regrese
`pnpm test` se 843 PASS a 6 volitelnými PG SKIP. Skeleton i závazný
OpenAPI prošly; veřejný kontrakt zůstává na 151 cestách a 274 schématech.
Webový test script sám jen deklaruje smoke test a nedokládá aktuální
vizuální ani produkční akceptaci. Reindex Chroma odmítl native handoff
kvůli identitě repozitáře; použitá byla přímá revize zdrojů, bez přestavby
indexu či obcházení této kontroly.
