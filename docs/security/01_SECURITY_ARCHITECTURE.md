# Security architecture

## Fail-closed routing location errors

Reviewed road routing maps direct Valhalla `/route` HTTP 400 + numeric 171
to 422 `ROUTING_LOCATION_NOT_ROUTABLE`, not an availability exception. It
reveals no provider text or presumed point index. Verified over-tolerance
geometry yields target/waypoint-specific 422. No route/proof, dropped vehicle
or closure requirement, widened tolerance or automatic fallback is allowed.
Geometry/closure violations and outages retain protective errors. No extra
provider call, public port, secret, GPS logging or traffic/measurement writer
is introduced. See [ADR 0036](../adr/0036_FAIL_CLOSED_ROUTING_LOCATION_ERRORS.md).

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

Privátní Driver mutation scope je pouze interní korelace na skutečný Root
kontext. SIM snapshotuje chráněný kontext před prvním await a vyžaduje
stejný scope v pre/post admission a dispatchi. Scoped v2 se nesmí snížit
na ordinary v1 a nesmí rozšířit ordinary read při pending cleanup.
Samotné UUID/reference, syntetický port nebo databázové ready nepředstavují
Root oprávnění. Nový scoped podpis a nativní transport vyžadují samostatné
ověření; nejsou touto aplikační validací aktivované.

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
## Consented Jízda measurements

The dedicated COP bearer authenticates the service, not a claimed client user.
COP derives UTC-day pseudonyms from authenticated users, verifies separate
revocable consent and strips sensitive journey endpoints. SIM HMACs those
pseudonyms, strictly rejects unknown fields and never persists raw GPS.
No browser Origin, mobile-held SIM token, arbitrary identity, free text,
private incident/message data, direct provider fallback or AI export is allowed.
Derived measurements are pseudonymous, not automatically anonymous. The
five-contributor threshold cannot certify distinct people; COP is responsible
for integrity. Outputs remain shadow-only and do not alter traffic speeds.
Separate database/runtime rights, 7-day retention, revocation, backup cleanup
and activation gates are defined in
[the Jízda contract](../integration/20_JIZDA_DRIVER_MEASUREMENTS_CONTRACT.md).
Production also HMACs batch/ETA UUIDs and request digests; measurement HTTP
tracing is omitted. The dedicated internal bridge has no public measurement
port and the web gateway rejects this path. Revocation remains independent of
intake. In the account-erasure source candidate, retention requires an accepted
owner-maintenance consumer after explicit initialization. Neither construction,
an intake/revocation flag, database time nor the standalone CLI authorizes SQL
cleanup. The production consumer is unbound, so this candidate must not replace
the running image until guarded retention is accepted. Restore quarantine is mandatory;
physical cluster backup expiry is not guaranteed by SQL deletion. See
[production runbook 17](../runbooks/17_DRIVER_MEASUREMENTS_PRODUCTION.md).

## Nezávislá ochrana obnovy účtu — připravovaný koordinovaný cutover

Schválené mazání COP/Jízdy nesmí odvolat společnou identitu ani oprávnění
SIM/IZS. Obnovené `ready` nebo platně podepsaná historická odpověď nejsou
oprávnění vrátit účet do provozu. Aktuální nezávislá registry, frontier,
runtime/source proof, owner policy a přesná cílová schema/privilege fakta
musí souhlasit. Nová obnova nebo Root epoch vyžaduje kontrolovaný replay
a skutečný consumer drain/cohort; samotná absence souboru nebo TTL nestačí.

Root čtení/reporty drží sdílený session zámek, mutation a přechody jeho
exkluzivní protějšek. Ztráta spojení může odstranit PostgreSQL zámek,
aniž prokáže dokončení cílové práce: Root proto musí uchovat nezávislý
process-global HOLD a odmítnout další writer. Nejistý SQL výsledek se
řeší jen nad původním neměnným originem/dispatch claimem; ne s novým
časem, UUID nebo nahrazeným tělem.

Různé historické/aktuální owner politiky jsou přijatelné jen s ověřeným
originálem A, předem podepsaným T, neměnným intent/dispatch a nezávisle
podepsanou B. Skutečný common opakuje DB C1/C2, globální policy,
procesní cohort, frontier a target kontroly. Archivace je povolena jen
skutečnému exkluzivnímu `checkpoint-publish` kontextu; kopie objektu ani
samotný helper historie nejsou autorita. Vypršelý target se pro běžné
čtení nikdy neoznačuje za aktuální.

Samostatný `source-refresh` smí Root provést jen za stále platné původní
autority, v téže exkluzivní metadata session a přes pevný omezený SQL RPC.
Porovnávají se celé původní PG řádky, nikoli jen vybrané atributy. Nový
proof nepřepisuje existující kontext, checkpoint nebo procesní registraci.
Před RPC vznikne neměnný podepsaný intent a dispatch; neznámý výsledek
nesmí vytvořit další pokus s novým UUID. Watchdog přepne HOLD, ale nezavírá
metadata socket držící bariéru. Restartové vyřešení původního originu
a nová nezávisle přijatá kohorta zůstávají podmínkou aktivace, nikoli
automatickým reconnectem.

Tyto požadavky nejsou tvrzení o aktuálně přijaté produkční instalaci.
Izolované SQL a Root fixture důkazy i jejich omezení jsou v
[integraci 23](../integration/23_SIM_ACCOUNT_SAFETY_RUNTIME_PREPARATION.md)
a [runbooku 19](../runbooks/19_COP_ACCOUNT_ERASURE_PRODUCTION.md).
