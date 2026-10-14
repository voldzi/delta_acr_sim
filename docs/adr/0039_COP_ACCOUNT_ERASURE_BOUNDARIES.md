# ADR 0039 Mazání účtu COP v SIM

Stav: návrh k bezpečnostnímu a retenčnímu posouzení. Není povolením produkčního mazání.
Datum: 13. 10. 2026. Upřesnění rozsahu: 14. 10. 2026.
Navazuje na ADR 0026, ADR 0030 a ADR 0038.

Tento podklad zahrnuje pouze kontrakt a návrh. Sám nepovoluje runtime
implementaci, migraci, nové granty, produkční aktivaci ani mazání syntetických
nebo skutečných účtů. Retenční návrh zůstává k samostatnému schválení.

## Rozsah

COP řídí životní cyklus svého účtu a předává SIM jen serverově odvozenou
identitu. Smazání v SIM se skládá z oddělených důkazů pro dobrovolná měření
a COP namespace AI Routeru. Nezahrnuje automaticky COP profil, komunikaci,
historické identity operátorů SIM/IZS, poskytovatelovy kopie ani fyzické zálohy.

Dosavadní denní revokace a odstranění BYOK klíče nejsou smazáním celého účtu.
SIM neumí z denního pseudonymu zjistit všechny dny přispěvatele. AI Router
odstraněním klíče nemaže audit klíče ani historii tokenů a nákladů.

## Navržená rozhodnutí

Připravit samostatnou, výchozím nastavením vypnutou operaci
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

Výchozí nákladová politika zůstává `pending_requires_review`. Kandidátem
je `aggregate-costs-current-month-v1`: odstranění uživatelských vazeb,
request IDs a otisků klíče po atomickém převodu potřebných součtů do
minimalizované interní evidence bez přímé vazby na uživatele. Pole této
evidence a navržená expirace jsou v integračním návrhu. Nejde automaticky
o anonymní data, zejména při malém počtu účtů.

Převod součtů, odstranění navázaných řádků a potvrzení operace musí být
jednou transakcí pod stejnými finančními zámky jako rezervace. Spotřeba
a limity čtou součty i dosud navázané řádky bez dvojího započtení.
Smazání účtu nesmí snížit globální denní či měsíční finanční strop.

## Zálohy, logy a návrat

SQL smazání nevymaže WAL, snapshoty, PBS ani poskytovatelovy záznamy.
Správce infrastruktury musí potvrdit horizont kopií, karanténu obnovy
a opakované uplatnění aktuální fronty mazání před návratem do provozu.
Historická hodnota `ready=true` obnovená ze zálohy sama tento důkaz nenahrazuje.

Dokud není schválená konkrétní retence účtovací evidence, minimálních
replay tombstones, logů a historických aliasů, zůstávají odpovídající
části akceptace otevřené. Návrat k obrazu, který nezná erasure fence,
vyžaduje zablokování příslušných vstupů; pouhé vypnutí nového endpointu
nesmí obnovit zaniklý účet nebo jeho klíč.

## Návaznost

Přesná inventura, návrh kontraktu, testovací scénáře a předávací hranice
jsou v [integračním návrhu 22](../integration/22_COP_ACCOUNT_ERASURE_CONTRACT.md).
Produkční aktivace, nová tajemství, granty a skutečné mazání nejsou touto
zdrojovou přípravou schváleny.
