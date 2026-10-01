# Security architecture

**Status:** Baseline dokumentace

## Cíle

- chránit secrets a konfiguraci
- zabránit publikaci nevalidních nebo nesyntetických dat
- auditovat změny scénářů, runtime a AI
- umožnit okamžité zastavení publikace
- oddělit role a oprávnění

## Hranice důvěry

Důležité hranice jsou browser/UI, backend API, store/queue, externí AI provider a COP ingest API. Každá hranice vyžaduje auth, validaci a audit podle rizika.

## Public operator boundary

SIM může být vystaven jako samostatné internetové operační centrum pouze přes
webový shell chráněný Keycloakem. Veřejně dostupné smějí být:

- statické webové UI,
- `GET /health/live`,
- `/api/v1/*` pouze jako browser API ověřené přes `Authorization: Bearer`
  Keycloak access token a SIM role.

Produkční internetový profil používá `SIM_API_AUTH_REQUIRED=true` a
`SIM_API_PUBLIC_READ=false`. Fallback statické tokeny mohou existovat jen jako
break-glass/server-side provozní nástroj a nesmí být nabízeny ve veřejném UI.

## Provider boundary

SIM dál běží jako server-to-server provider pro COP backend. Provider katalogy,
bbox query, detailní source endpointy, readiness, observability a partner/TAK
endpointy zůstávají interní/VPN-only. COP frontend a mobilní klienti mají volat
COP API, nikoli provider endpointy SIM přímo.

`valhalla.home.cz:8002` patří do stejné interní/VPN-only hranice. Veřejný
browser ani COP klient jej nesmí volat přímo. Updater má pouze odchozí přístup
nutný pro pinované images a veřejné mapové/elevation zdroje; release manifest
nesmí obsahovat credentials.

## AI Router a hranice COP kontextu

AI Router je interní server-to-server služba. Samotná autentizace služby COP
neznamená, že její kontext smí opustit infrastrukturu: externí `cop_chat`
vyžaduje explicitní opt-in a typovanou, atestovanou třídu `synthetic`,
`public_aggregate` nebo odděleně povolenou `internal_minimized` podle
[kontraktu](../ai/10_SHARED_AI_ROUTER.md). Poslední třída připouští jen
strukturované stavy zdrojů a číselné provozní metriky, nikdy volné záznamy;
její produkční přepínač zůstává vypnutý do společné akceptace.
`internal` používá jen lokální model bez externího fallbacku. Router
ověřuje strukturu, politiku a rozpočty; nemůže sám ověřit pravdivost původu
dat nebo sémanticky zaručit, že otázka neobsahuje osobní údaje. COP proto
musí před sestavením requestu odmítnout dešifrované soukromé zprávy,
identifikovatelné osoby, citlivé incidenty, neupravené záznamy a volný
kontext. Před aktivací externího `internal_minimized` se navíc musí ověřit
konkrétní OpenAI API projekt, retence a případná evropská rezidence;
`store:false` samo o sobě neznamená nulové uchování. Chyba Routeru se nesmí
obcházet přímým voláním OpenAI.

Nový, zatím vypnutý [COP BYOK kontrakt](../ai/11_COP_BYOK_AND_SIM_IZS_ROUTER.md)
je jiná cesta: samotnou otázku napsanou uživatelem smí COP po jeho vědomé
volbě předat do OpenAI Global pod jeho vlastním projektovým klíčem, včetně
údajů, které do ní sám vložil. Automaticky připojený kontext však zůstává
omezen na typované zveřejněné položky s původem, časem platnosti a kontrolou
COP. Router nedokáže ověřit autorství textu ani pravdivost zveřejnění.
Uživatelské klíče ukládá šifrovaně, identitu COP ověřuje podepsaným
krátkodobým tvrzením, nepřijímá klientskou volbu cizího účtu a při výpadku
nesmí přejít na sdílený placený účet. Oddělená SIM/IZS větev má vlastní
roli, token, projekt a audit; jen syntetické či zveřejněné agregáty.

## Zákazy

Systém nesmí obsahovat reálná operační data, secrets v repozitáři, targeting, navádění nebo bojové workflow.

## Traffic freshness security boundary

The internal Valhalla feed/report/status retain their existing bearer boundary.
Additive `overlayGeneration`, `usableUntil` and `sourceTiming` metadata do not
contain provider keys, source XML or private road geometry. The host commits
deadline and report state before network acknowledgement; SIM rejects obsolete
report ordering and never extends a live speed based on HTTP 304 or report age.
Missing/invalid timestamps or a corrupt applied-edge ledger fail closed. A
provider/report outage removes live-speed authority without exposing raw data
or replacing the traffic feed with a public browser integration. See
[ADR 0028](../adr/0028_TRAFFIC_FRESHNESS_AND_EXPIRY_BOUNDARY.md).
