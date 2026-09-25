# ADR 0024: Sdílená služba AI Router v repozitáři SIM

**Stav:** Interní služba a SIM textový náhled aktivní; agregovaný COP MCP
adaptér je připraven jako vypnutelný další krok.

## Rozhodnutí

AI Router je samostatná interní služba a balíček v repozitáři SIM. Není součástí
veřejného Situation Data API ani rozhodovacím jádrem COP. COP a SIM jsou
samostatní autorizovaní konzumenti. COP dál vlastní identitu uživatele,
policy-filtered kontext, chatové oprávnění, E2EE hranici a lidské schválení.
SIM dál vlastní původ a kvalitu dat a syntetické scénáře. Router vlastní jen
volbu povoleného modelu, volání providera, rezervaci rozpočtu a záznam spotřeby.
Strukturovaný civilní návrh smí z modelu převzít pouze omezený název, popis,
dobu a počet syntetických hlášení. SIM sama sestaví pevný `report-sim` blok,
ověří schéma a ponechá lidské přijetí i spuštění oddělené. Model nesmí
určovat bloky, polohu, oprávnění ani publikování.

Existující COP AI chat a nový COP OpenAI souhrn zdrojů se bez samostatného
integračního kroku **nemění**. Vypnutí Routeru nesmí odstavit mapu, routing,
SIM datové zdroje ani lidskou komunikaci. Router je ve Compose za profilem
`ai-router` bez publikovaného portu. Žádný prohlížeč ho nesmí volat přímo.

První COP integrace smí změnit výhradně agregovaný `cop.sources.health`
a jeho read-only spotřebu. Router vrací stejné celkové rozpočtové součty
autentizovaným službám bez detailů požadavků. COP chat, situační shrnutí a
Matrix E2EE nejsou v tomto kroku povoleny pro externí Router.

## Bezpečnost a data

- Oddělené bearer identity COP, SIM a správce; interní data mají pouze lokální
  model. Externí volání vyžaduje globální povolení i explicitní povolení
  konkrétního požadavku. Dražší model vyžaduje další explicitní volbu.
- Původní prompt se neukládá do rozpočtové databáze. Uživatelský identifikátor
  se ukládá jen jako hash se samostatným tajným pepperem. Klíče nejsou v Gitu.
- Rozpočtová rezervace a limity se vyhodnocují transakčně v PostgreSQL.
  Neznámá nebo neúspěšná spotřeba ponechá konzervativní rezervaci.
- Cena je interní odhad podle schváleného ceníku a zvoleného režimu, nikoli
  faktura poskytovatele. Změna ceníku, regionu, modelu či nástrojů vyžaduje
  revizi odhadu před povolením.
- Router nemá MCP tool calling a nepřijímá plaintext historické Matrix E2EE
  timeline automaticky. COP předává pouze záměrně vybraný kontext.

## Směrování

Deterministická levná klasifikace používá typ úlohy, délku a vybrané signály
složitosti. Jednoduché automatické dotazy mají přednostně lokální model.
Složitější schválené veřejné či syntetické úlohy mohou použít ekonomický
externí model. Vyšší tarif nelze vybrat automaticky bez explicitního povolení.
Tento klasifikátor není samostatný LLM a nespotřebovává placené tokeny.

## Pořadí zavádění

1. Služba, kontrakt, databázové limity, testy a read-only stav bez produkčního
   provozu (současná fáze).
2. Bezpečný proxy přístup ke stavu, modelům a politice z administračního
   rozhraní SIM; role SIM_AI_ADMIN, audit změn, nikoli přímý přístup pro
   browser (implementováno lokálně, bez produkční acceptance).
3. Syntetická neprodukční SIM úloha přes Router. Ověřit náklady, výpadek,
   citlivé třídy a lidské schválení.
4. COP integrační kontrakt a zkušební provoz vedle stávajícího AI chatu.
   Přepínat po jedné funkci; zachovat rollback na dosavadní COP AI gateway.
5. Teprve po všech migracích ukazovat routerové součty jako úplnou spotřebu.
   Použití stejného OpenAI klíče mimo Router se do jeho evidence nepromítá.

## Alternativy

- Rozšířit pouze COP AI gateway: jednoduché pro COP, ale nevytvoří společnou
  správu pro SIM a další konzumenty.
- Vložit Router přímo do Situation Data API: odmítnuto kvůli provoznímu,
  bezpečnostnímu a dostupnostnímu svázání datové a placené AI cesty.
