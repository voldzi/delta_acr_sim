# ADR 0039 Mazání účtu COP v SIM

Stav: schválená zdrojová implementace s oddělenou produkční akceptací.
Datum: 13. 10. 2026. Upřesnění rozsahu: 14. 10. 2026.
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
