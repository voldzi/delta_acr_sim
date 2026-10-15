# ADR 0039 Mazání účtu COP v SIM

Stav: schválená zdrojová implementace s oddělenou produkční akceptací.
Datum: 13. 10. 2026. Upřesnění rozsahu: 15. 10. 2026.
Navazuje na ADR 0026, ADR 0030 a ADR 0038.

Vlastník 14. 10. 2026 přímo v chatu SIM schválil implementaci, omezené
migrace a práva, izolované syntetické PostgreSQL testy a nasazení po společném
ověření s COP. Nejde o souhlas k mazání skutečných účtů pro test, ke změně
chatu nebo k volání poskytovatele. Schválená nákladová retence je níže.
Aktivace stále vyžaduje skutečnou autoritu obnovy a doložené společné testy;
podpis nebo historická hodnota `ready` není takovým důkazem.

## Rozsah

COP řídí životní cyklus svého účtu a předává SIM jen serverově odvozenou
identitu. Smazání v SIM se skládá z oddělených důkazů pro dobrovolná měření
a COP namespace AI Routeru. Nezahrnuje automaticky COP profil, komunikaci,
identity, přístup ani historii operátorů SIM/IZS, poskytovatelovy kopie nebo
fyzické zálohy. Vlastník výslovně zvolil odstranění COP/Jízdy při zachování
společného účtu a přístupu do SIM. COP nesmí smazat uživatele sdíleného
Keycloak realmu, vyvolat globální logout ani odvolat oprávnění SIM.
Router vrací `aliasScope=sim_izs_preserved_out_of_scope`; zachování mimo
rozsah není nevyřešeným aliasem ani blockerem smazání COP/Jízdy.

Dosavadní denní revokace a odstranění BYOK klíče nejsou smazáním celého účtu.
SIM neumí z denního pseudonymu zjistit všechny dny přispěvatele. AI Router
odstraněním klíče nemaže audit klíče ani historii tokenů a nákladů.

## Rozhodnutí

Implementovat samostatnou, výchozím nastavením vypnutou operaci
`sim-account-erasure-v1`. Existující kontrakt `sim-driver-measurements-v1`
a jeho režim `shadow_only` se nemění. Mazání nepoužívá OpenAI a nesmí být
závislé na zapnutém chatu, příjmu měření nebo externím zpracování.

COP pod zámkem účtu nejprve zablokuje nové odesílání, odvolá souhlas,
zvýší generaci outboxu a uloží trvalou frontu mazání. Teprve potom smí
ztratit údaje potřebné k odvození denních pseudonymů. Telefon ani prohlížeč
nevybírá cizí účet, plátce, pseudonymy, službový token ani podpis.

Nové tvrzení služby má účel `aud=sim-account-erasure`, krátkou platnost
a přesná pole `iss`, `sub`, `aud`, `iat`, `exp`, `operationId`, `routerUserId`.
`iss` a `sub` vážou operaci na ověřenou relaci COP; `routerUserId` musí být
přesně dosavadní neprůhledná identita pro BYOK a legacy COP chat, nikoli
nový hash pro mazání. Backend používá zvlášť vazbu operace a zvlášť stávající
klíč cílových dat. Neověřená historická derivace je blockerem, nikoli důkazem
prázdného účtu. Běžný podpis pro AI chat není oprávněním
mazat účet. Provozní schválení musí výslovně zahrnout nový účel podpisu,
službové oprávnění a potřebné omezené DML granty; nový privilegovaný
`SECURITY DEFINER` není součástí minimálního návrhu.

Operace váže identitu, ID a digest neměnného požadavku. Nový čas podpisu
při opakování nemění digest. Konflikt identity nebo manifestu nesmí
vrátit cizí výsledek. Restart nesmí ztratit čekající stav ani zákaz
pozdního vytvoření klíče, rezervace nebo příspěvku.

HTTP 202 znamená čekající smazání. HTTP 200 smí potvrdit pouze přesně
vyjmenovaný a ověřený online rozsah. `wholeAccountComplete` zůstává
`false`; složené dokončení celého účtu řídí COP až po potvrzení všech
jeho závislostí a povinných retenčních výjimek.

## Měření a odvozené reporty

Retence sedm dnů běží od přijetí dávky. Příjem navíc dovoluje pozorování
staré 24 hodin. Manifest proto pokrývá den `UTC-date(acceptedAt − 8 dní)`
až UTC den prvního přijetí operace v SIM, případně následující UTC den
na hranici tolerance 30 sekund. COP zahrne také doložený outbox/retained inventář.
Obsahuje všechny použité klíčové verze a doložené čekající dávky; nesmí
být potichu zkrácen. SIM ověří tvar a rozsah, ale pravdivost příslušnosti
pseudonymů k účtu a úplnost manifestu zaručuje COP.

Revokace a commit musí používat stejné zámky. Po dokončení se znovu ověří
nulové uložené příspěvky pro předané pseudonymy a potvrzení invalidace
odvozeného reportu. Procesová epocha reportu nechrání před jinou replikou,
která by mohla později zapsat starý snapshot. Bez technické sdílené ochrany
publikace nebo prokazatelně vynuceného jediného writeru je výsledek čekající.

Nový trvalý erasure ledger nemá vytvářet spojovací historii
`account → všechny denní příspěvky`. Pro retry postačí HMAC identita operace,
digest, stav a omezené výsledky; manifest může znovu dodat trvalá fronta COP.
Případné ukládání širší vazby vyžaduje zvláštní změnu datového modelu a review.

Retenční úklid má výslovný životní cyklus `init → start/runOnce → close`.
Konstruktor nezakládá časovač ani nespouští SQL. Dvě expirace běží v jedné
transakci s neměnným cutoff z owner-bound maintenance consumeru; nemažou
permanentní fence nebo erasure ledger. Úklidy se nepřekrývají a `close`
čeká na skutečnou práci callbacku i tehdy, když consumer předčasně ukončí
svou vlastní promise. Toto čekání není důkaz nativního drain nebo abortu.

Lokální TypeScript port a ověření tvaru cutoff nejsou infrastrukturní
oprávnění. Produkční consumer zatím není připojený, takže úklid zůstává
unavailable; stejně se chová samostatný maintenance entrypoint bez přímého
SQL obchvatu. Příjem, revokace a ostatní SIM/IZS služby se kvůli chybějící
maintenance závislosti plošně nevypínají. Tato zdrojová změna nesmí být
nasazena bez přijaté skutečné autority a společné akceptace retence.

Samostatný expiration SQL zdroj nad nezměněným skutečným driver schématem
ověřuje konkrétní původní transakci a marker, nikoli nové produkční oprávnění.
Pevné `SECURITY DEFINER` funkce pod NOLOGIN ownerem jsou pouze odděleným
source kandidátem; jejich instalace není součástí původního minimálního návrhu.
Origin neuchovává denní contributor identitu ani manifest. Jednorázový seal
se smí vydat za terminal až po skutečném control COMMIT a čerstvém readbacku.
Před omezením runtime DELETE musí být společně upraveny revoke, erase a
provisioning; jinak se legitimní mazání zastaví. Konkrétní podmínky pevných
scope, writer generace a práv jsou v integraci 23.

## AI náklady a rozpracované požadavky

Zákaz po zahájení mazání se musí vztahovat na BYOK správu, rezervaci,
nový chat i starší COP `/generate`. Nesmí nastat náhradní účtování
sdíleným klíčem. Již odeslaný požadavek nelze vzít zpět u poskytovatele;
jeho pozdní výstup se uživateli nevrací a náklad se konzervativně dokončí.
Neuzavřená rezervace po pádu služby znamená čekající stav, nikoli úspěch
odvozený jen z uplynulého času.

Provozní retence `aggregate-costs-current-month-v1` byla vlastníkem
výslovně schválena dne 14. 10. 2026. Zahrnuje odstranění uživatelských vazeb,
request IDs a otisků klíče po atomickém převodu potřebných součtů do
minimalizované interní evidence bez přímé vazby na uživatele. Pole této
evidence a schválená expirace jsou v integračním návrhu. Nejde automaticky
o anonymní data, zejména při malém počtu účtů.

Převod součtů, odstranění navázaných řádků a potvrzení operace musí být
jednou transakcí pod stejnými finančními zámky jako rezervace. Spotřeba
a limity čtou součty i dosud navázané řádky bez dvojího započtení.
Smazání účtu nesmí snížit globální denní či měsíční finanční strop.

Schválení provozní retence samo nezapíná mazání ani nenahrazuje skutečný
owner checkpoint. Bez jeho potvrzení zůstává nákladová část čekající.
Odmítnutí zachování součtů vyžaduje jinou výslovně schválenou variantu
zachovávající finanční stropy; nikoli skrytou retenci nebo reset limitů.

## Zálohy, logy a návrat

SQL smazání nevymaže WAL, snapshoty, PBS ani poskytovatelovy záznamy.
Správce infrastruktury musí potvrdit horizont kopií, karanténu obnovy
a opakované uplatnění aktuální fronty mazání před návratem do provozu.
Historická hodnota `ready=true` obnovená ze zálohy sama tento důkaz nenahrazuje.

Vedle schválených nákladových součtů musí být určena retence minimálních
replay tombstones, logů a historických aliasů. Do té doby zůstávají odpovídající
části akceptace otevřené. Návrat k obrazu, který nezná erasure fence,
vyžaduje zablokování příslušných vstupů; pouhé vypnutí nového endpointu
nesmí obnovit zaniklý účet nebo jeho klíč.

## Návaznost

Přesná inventura, návrh kontraktu, testovací scénáře a předávací hranice
jsou v [integračním návrhu 22](../integration/22_COP_ACCOUNT_ERASURE_CONTRACT.md).
Závazný kontrakt je v `openapi/openapi.json`. Zdroj, testy, migrace,
nasazení a aktivace jsou samostatné kroky. Výchozí neexistující chráněný
ověřovatel vrací neaktuální checkpoint; nevzniká nová mazací operace.
Správce infrastruktury musí před aktivací doložit současný autoritativní
stav mazání nezávislý na obnovované aplikační databázi. Nová guard služba,
její databáze, síť a klíče nejsou součástí omezených aplikačních migrací.

Vlastník 14. 10. 2026 samostatně schválil přípravu a ověření infrastrukturní
ochrany proti návratu smazaných dat. Správce připraví konkrétní omezený
privilegovaný balíček a skutečnou runtime hranici. Návrhový podpis,
syntetický verifier nebo samotná testovací DB nemění stav produkční gate;
shared SIM identita a přístup se nesmějí globálně odvolat.

Testovací šestimetodový `cop-actor-peer-isolated-v1` má oddělený offline
codec a klient pod `scripts/lib`, bez produkčního importu či transportu.
Jeho všechny authority flags a kompatibilita s runtime zůstávají false.
Deterministický timeout není terminal outcome nebo drain. Nová verze
nativního wrapperu, owner-wide generace, bootstrap identity a skutečné
commit/fence pořadí vyžadují samostatný přijatý kontrakt. Izolovaná Linux
fixture, samotná metadata DB a aplikovaný JSON tvar tuto hranici nemění.

Samostatný `cop-dormant-boundary-fixture-v5` má vlastní čistý Node codec a
paměťového klienta; v1 ani v4 a jejich historické důkazy se nepřepisují.
Offline porovnání s připnutými čistými Python funkcemi ověřuje bytes,
DTO a korelaci, nikoli skutečné registry/evidence nebo externí efekty.
Návrh budoucího in-process Node-API transportu je dokumentace, bez nové
závislosti, binárního sestavení nebo produkčního zapojení. Přijatý permit
je hranice autorizace původního efektu; timeout ani změna procesu z něj
neodvozují známý abort. Skutečný transport, bootstrap, nezávislý anchor,
restore a následná společná aplikační akceptace zůstávají oddělené gates.

[Konkrétní zdrojová příprava 23](../integration/23_SIM_ACCOUNT_SAFETY_RUNTIME_PREPARATION.md)
mapuje současné HTTP kontrakty a transakční švy na budoucí consumer boundary.
Její instalační manifest je neaktivní inventář bez proveditelných actions,
nových operation codes nebo pozitivního verifieru. Existující HTTP/DB
digests se nepřijímají jako Root schema, registered lease nebo oprávnění.
Neaktivní B1 balíček a skutečná B2/B3 autorita se přijímají odděleně;
žádná zdrojová mapa nesmí rozdělit same-transaction fence nebo globálně
odvolat shared SIM/IZS identitu a přístup.

Koordinovaný driver SQL patch `003_guarded_operations.sql` z 15. 10.
rozšiřuje fixed-origin mechanismus na revoke, erase a typovaný publication
readback/ACK. Origin neuchovává manifest ani novou account/day vazbu.
Runtime přejde na intake INSERT, čtení a receipt-only UPDATE teprve současně
se skutečným Root-owned executorem; samotné odebrání DELETE není nasazení.
Provisioning nesmí guarded instalaci vrátit na blanket DML. Účinné PUBLIC
column granty se kontrolují a odstraňují stejně jako table-level práva.

SQL ACK porovnává přesný uzamčený skutečný readback, ale podpis, aktuální
reference, původ manifestu a report inventory musí ověřit skutečná Root
registrace. Kontext z aplikace ani pozitivní testovací fixture nestačí.
Bez něj ACK ledger nemění. Osmnáct nových izolovaných SQL případů má
[samostatný záznam](../archive/2026-10-15_DRIVER_GUARDED_OPERATIONS_SQL.md);
neprokazuje nasazení, restore ani whole-account completion.

Opt-in aplikační napojení používá explicitní `DriverGuardedExecutionPort`
v SDA a náhrady čtyř mutujících cest v integraci 23. Guarded přítomnost
bez doručeného kontextu/portu/admission nepropadne do legacy SQL.
Typové deklarace a lokální adapter nejsou Root transport ani oprávnění.
Reference Root originu se odděluje od business operation ID; nejasný efekt
se zjišťuje pouze na stejném originu. `probe` může sealovat a nesmí se
volat z čtecího HTTP statusu. Chybějící původní scalar count po známém
revoke commit vrací nedostupnost, nikoli odhad nebo opakovaný DELETE.
Výchozí neguarded režim zůstává zachovaný do koordinované migrace.
Guarded read/intake gate ověřuje zúžená práva a účelový Root admission,
nikoli původní zero-argument verifier. Syntetické testovací porty nemění
stav chybějícího produkčního delivery, enrollmentu nebo restore.

Privátní read-only SQL funkce 004 vrací Driver pozorování, nikoli
oprávnění. Nezávislý Root vydavatel přijímá skutečné schema/privilege piny,
checkpoint a report inventory a váže je do krátkodobého účelového permitu.
Reader ověřuje aktuální registry/frontier/peer před i po čtení, bez
historického origin probe. Runtime nedostává nové EXECUTE ani grant RPC.
Přesný wire a vlastnictví jsou v integraci 23. Inline podepsané přijetí
nevytváří trvalou account/day historii a nenahrazuje generation/drain
nebo ochranu obnovy.

### Root checkpoint metadata a AI čtecí hranice

Driver SQL `005_root_checkpoint.sql` a AI Router SQL
`004_root_checkpoint_facts.sql` / `005_root_checkpoint.sql` jsou oddělené
zdrojové rozšíření, nikoli produkčně aplikované migrace nebo aktivace.
Předpokládají existující omezené role. Read-only AI 004 vytvoří prázdnou
privátní binding tabulku, nikoli vazbu; teprve oba settery vyžadují předem
přijatý store binding i existující singleton. Nevytvářejí role, secrets,
přístupové údaje, enrollment nebo novou inkarnaci. Aplikační tabulky
zůstávají dosavadním migrátorům. Každý setter přidává jen šest výslovných
UPDATE sloupců vlastním NOLOGIN ownerům a
EXECUTE pouze pevnému control kanálu, nikoli aplikačnímu runtime.

Root před aplikací nezávisle ověřuje skutečné aktuální podepsané
identity/continuity/replay a retenční/report/cost podklady. Typovaný
`rootRecordRef` se jen vrací, neukládá; sám není podpisem ani oprávněním.
Zámek checkpointu má limit jednu sekundu a proof deadline musí být po
získání zámku budoucí nejvýše o 30 sekund. Driver uloží platnost do
existujícího proof sloupce. AI ji pouze ověří a vrátí, bez nového TTL
sloupce a bez automatického zániku či odvození autority z DB flags.

Driver CAS porovná předchozí checkpoint hash, včetně skutečně null
počátečního stavu. AI CAS porovná ID i kanonickou bigint generaci a dovolí
jen přesné `+1` bez overflow. Aktivní a výslovně karanténní režim jsou
oddělené; smíšené readiness booleany se odmítají. Settery neprovádějí
mazání, neovlivní ledger/fences/klíče/náklady a nevolají se per-chat.
Změna jejich funkcí či ACL vyžaduje nový nezávisle přijatý privilege pin;
starý pin se nesmí potichu obejít nebo nahradit hodnotou z kontrolované DB.

AI read-only 004 zachovává dosavadní operation/schema digests a finanční
RLS, invoker views i retenční pravidla. Čistý validátor pozorování není
Root verifier. Pevný `root-checkpoint-read.mjs` před i po skutečném čtení
kontroluje podepsané permit/evidence, peer, registry/frontier,
boot/cluster/timeline a policy; vydává pouze krátkodobý inline podepsaný
read admission. Přesný wire je v integraci 23 a veřejné HTTP/OpenAPI
endpointy se nemění.

COP potvrdil nové čerstvé per-inspect permit/delivery v chráněném tmpfs,
bez trvalé per-read identity historie. Nemění to immutable execution
origin, jeho nejistý commit ani potřebu výslovné maintenance lease.
Potvrzený kontrakt není skutečné produkční doručení nebo akceptace obnovy.

[Driver005 důkaz](../archive/2026-10-15_DRIVER_ROOT_CHECKPOINT_SQL.json)
dokládá 8/8 nových syntetických PostgreSQL 18.3 skupin; AI čistá validace
prošla 10/10. [AI Linux ověření](../archive/2026-10-15_AI_ROOT_CHECKPOINT.md)
prošlo 14/14 skutečnými Root/TLS/SQL/compiled-BYOK skupinami, s výslovně
syntetickým peer, registry a provider odpověďmi. Při podpisu se zachovává
původní ověřený keyring snapshot a kontroluje neměnnost signer/keyringu;
nepřejímá se nový trust set pro staré důkazy.

Konkrétní Router composition pevně načítá COP nativní factory pouze z
předem ověřeného Root code tree, žádné env/HTTP selektory. Pro každý
snapshot vyžaduje fresh inspect, bez kladného fallbacku či HTTP cache.
Jeho třináct nových unit případů jsou pouze composition/FS stub testy,
nikoli skutečné Root přijetí. Nezávislá autorita, config/generation lease
a explicitní background maintenance lease zůstávají povinné.

Tyto výsledky se nepřičítají ke starším případům a neprokazují produkční
enrollment, produkční BYOK/key/chat paritu, nativní delivery nebo fyzický
restore. Tyto společné gates zůstávají otevřené; chat ani produkce se
nepřepínají.
