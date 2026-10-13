# API authentication

**Status:** Baseline dokumentace

Search partial-feed recovery (ADR 0034) does not change this access boundary.
Sanitized source warning markers never include provider error text, URLs or
credentials. Safety incompleteness stays explicit; a new search wrapper does
not grant notification eligibility or permission to use private AI context.

## SIM API

SIM API musí v implementaci vyžadovat autentizaci pro všechny neveřejné endpointy. Health liveness může být veřejný v lokálním režimu, readiness/dependencies mohou být omezené podle prostředí.

Produkčně platí, že SIM může být vystaven jako samostatné operační centrum jen
přes Keycloak/OIDC a SIM role. Provider endpointy nejsou veřejné browser API a
mají být dostupné pouze server-to-server z COP backendu, interních sítí nebo
VPN. Veřejně smí zůstat statické UI, `/api/v1/*` za bearer tokenem a
`GET /health/live`. Detaily Nginx allowlistu jsou v
[../runbooks/12_PROVIDER_ACCESS_CONTROL.md](../runbooks/12_PROVIDER_ACCESS_CONTROL.md).

SIM podporuje statické bearer tokeny i Keycloak/OIDC JWT. Doporučený produkční režim je `SIM_API_AUTH_MODE=hybrid`, kde Keycloak tokeny z realmu COP s rolemi `csm-sim-viewer`, `csm-sim-operator` a `csm-sim-admin` řídí běžné UI použití a statický `SIM_API_ADMIN_TOKEN` slouží pouze jako nouzový fallback. Pro sdílené účty v realmu COP SIM zároveň akceptuje `cop_user` jako viewer, `cop_operator` jako operator a `cop_admin` jako admin. Režim `oidc` vypíná statické tokeny.

Internetový profil musí mít `SIM_API_PUBLIC_READ=false`. `SIM_API_PUBLIC_READ=true`
je povoleno jen pro interní/lab režim a smí zpřístupnit pouze read-only dashboard
endpointy. Mutace scénářů, start/stop runtime, publisher queue, metriky a změny
konfigurace musí zůstat chráněné bearer tokenem vždy.

## Dobrovolná měření a jejich vyhodnocení

Vnitřní `/api/v1/internal/driver-measurements/v1/evaluation` zachovává
vyhrazenou službovou identitu COP, zákaz browser `Origin`, limity a `no-store`.
Neexistuje klientské přepnutí identity či účtu. Přístup všech ověřených účtů
se řídí na COP a stále vyžaduje jejich jednotlivý souhlas; nejde o anonymní
příjem ani přímý přístup telefonu do SIM.

Operátorský `GET /api/v1/operations/driver-measurements` vyžaduje
`SIM_VIEWER` i při `SIM_API_PUBLIC_READ=true`. Čte pouze přesný odvozený scalar
DTO: žádné GPS, pseudonymy, UUID dávek, hrany nebo provider payload. SIM API
nemá kopii měřicího tokenu, HMAC ani databázového přístupu. RW/RO transport
je vyhrazená podložka na X5, report mode 600; veřejný souhrn jej neobsahuje.

Po úspěšném odvolání publisher zneplatní starý snapshot a obnoví přehled před
potvrzením mazání. Při selhání starý report odstraní a vrátí 503; COP musí
ponechat stav pending. Tato ochrana je pro aktuální jedinou SDA instanci,
ne potvrzení odstranění záloh nebo budoucího traffic overlay. Více publisherů
a zapojení do ETA vyžadují trvalou generační ochranu a potvrzení všech writerů.
Podrobnosti: [kontrakt Jízdy](../integration/20_JIZDA_DRIVER_MEASUREMENTS_CONTRACT.md).

## COP publisher

Publisher používá bearer token jako baseline a návrhově podporuje mTLS/OIDC client credentials. `X-Source-System-Id`, `X-Contract-Version`, `X-Idempotency-Key` a `X-Correlation-Id` jsou povinné integrační hlavičky.

## Internal geo-routing-v1

`POST /situation-data/api/v1/geo-routing-v1/route` uses a separate opaque
service token for each consuming backend. Tokens are configured as
`actor:token` entries in `GEO_ROUTING_SERVICE_TOKENS`; the fixed audience is
`csm-sim-geo-routing-v1` and the operation scope is `geo-routing:route`.
Rate limiting and idempotency namespaces use the authenticated actor. A request
with a browser `Origin` header is rejected even when it carries a valid token.
The public client must call its own backend and must never call SIM or Valhalla.
Details are in
[19_GEO_ROUTING_V1_CONTRACT.md](../integration/19_GEO_ROUTING_V1_CONTRACT.md).

## Audit

Auth selhání a změny auth konfigurace se auditují bez ukládání tajných hodnot.

## Interní AI Router

Samostatné neprůhledné bearer tokeny rozlišují službu COP, SIM a správce.
Pouze identita COP smí použít `taskType=cop_chat`; token nikdy nepřechází do
prohlížeče. Router nevyvozuje třídu dat z tokenu ani z modelové preference:
vyžaduje přesnou klasifikaci a pro externí COP chat navíc explicitní
`allowExternal=true` a atestovaný `copContext`. Ochrana neumožňuje přímý
fallback do poskytovatele při výpadku modelu, databáze nebo limitu.
`internal_minimized` navíc vyžaduje COP identitu, `preference=external`,
výslovné `allowPaidEscalation=false`, přesnou atestaci
`cop-internal-minimized-reviewed-v1` a oddělený výchozím nastavením vypnutý
provozní přepínač. Router odmítá neznámé klíče a volný text v položkách;
samotný token ani atestace nedokazují skutečnou minimalizaci. Tu musí před
odesláním zajistit COP. Běžný `internal` zůstává výhradně lokální.
