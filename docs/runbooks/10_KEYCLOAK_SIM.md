# Keycloak for SIM

SIM muze pouzit stejny Keycloak realm a stejne uzivatelske ucty jako COP. Opravneni SIM ale musi byt oddelena vlastnimi rolemi a vlastnim klientem.

## Doporučené nastavení

- realm: `cop`
- public client: `csm-sim-web`
- redirect URI: `https://sim.zeleznalady.cz/*`
- web origin: `https://sim.zeleznalady.cz`
- PKCE: `S256`
- role:
  - `csm-sim-viewer`
  - `csm-sim-operator`
  - `csm-sim-admin`
  - `csm-sim-ai-user`
  - `csm-sim-ai-admin`

SIM API mapuje tyto Keycloak role na interní role `SIM_VIEWER`, `SIM_OPERATOR`, `SIM_ADMIN`, `SIM_AI_USER` a `SIM_AI_ADMIN`. Role mohou být realm role nebo client role klienta `csm-sim-web`.

Kvuli sdilenemu realmu COP jsou podporovane i existujici COP role:

- `cop_operator` -> `SIM_OPERATOR` + `SIM_VIEWER`
- `cop_admin` -> `SIM_ADMIN`
- `cop_user` -> `SIM_VIEWER`

## kcadm příklad

```bash
/opt/keycloak/bin/kcadm.sh config credentials \
  --server https://login.zeleznalady.cz \
  --realm master \
  --user <keycloak-admin>

/opt/keycloak/bin/kcadm.sh create clients -r cop \
  -s clientId=csm-sim-web \
  -s publicClient=true \
  -s standardFlowEnabled=true \
  -s directAccessGrantsEnabled=false \
  -s 'redirectUris=["https://sim.zeleznalady.cz/*"]' \
  -s 'webOrigins=["https://sim.zeleznalady.cz"]' \
  -s 'attributes.pkce.code.challenge.method=S256'

for role in csm-sim-viewer csm-sim-operator csm-sim-admin csm-sim-ai-user csm-sim-ai-admin; do
  /opt/keycloak/bin/kcadm.sh create roles -r cop -s name="$role" || true
done
```

## SIM env pro internetový profil

Pro vystavení `https://sim.zeleznalady.cz` musí být anonymní čtení vypnuté.
V produkčním pilotu používáme `hybrid`: Keycloak je jediná uživatelská cesta ve
webovém UI a statický `SIM_API_ADMIN_TOKEN` zůstává jen jako server-side
break-glass token pro smoke testy a lokální správu. Pokud existuje spolehlivý
způsob získání provozního Keycloak tokenu pro automatizované testy, lze přejít
na striktní `SIM_API_AUTH_MODE=oidc`.

```bash
SIM_API_AUTH_REQUIRED=true
SIM_API_PUBLIC_READ=false
SIM_API_AUTH_MODE=hybrid
SIM_API_ADMIN_TOKEN=<high-entropy-break-glass-token>

SIM_OIDC_ISSUER=https://login.zeleznalady.cz/realms/cop
SIM_OIDC_JWKS_URI=http://docker.home.cz:8081/realms/cop/protocol/openid-connect/certs
SIM_OIDC_CLIENT_ID=csm-sim-web
SIM_OIDC_ALLOWED_CLIENTS=csm-sim-web

VITE_SIM_AUTH_MODE=hybrid
VITE_SIM_OIDC_ISSUER=https://login.zeleznalady.cz/realms/cop
VITE_SIM_OIDC_CLIENT_ID=csm-sim-web
VITE_SIM_OIDC_SCOPE=openid profile email
VITE_SIM_PUBLIC_READ_ENABLED=false
VITE_SIM_ALLOW_TOKEN_LOGIN=false
```

`SIM_API_AUTH_MODE=oidc` vypne staticke SIM tokeny a povoli pouze Keycloak JWT. Pouzij ho az po overeni, ze existuje alespon jeden spravce s roli `csm-sim-admin`.

## Chování v UI

SIM web pouziva Authorization Code + PKCE. Po prihlaseni posila access token jako
`Authorization: Bearer <token>` na SIM API. Token neni vkladany do HTML ani do
JavaScript bundle jako secret.

Role v UI:

- `csm-sim-viewer`: operační náhled a detail providerů,
- `csm-sim-operator`: viewer + řízení scénářů a fault injection,
- `csm-sim-admin`: viewer + publisher administrace,
- `csm-sim-ai-user`: AI drafty; pro plný přístup do konzole ji přiděluj společně
  s `csm-sim-viewer`,
- `csm-sim-ai-admin`: AI konfigurace; pro plný přístup ji přiděluj společně s
  `csm-sim-viewer`.

Read-only dashboard endpointy nemají být na internetu anonymní. Pokud je
`SIM_API_PUBLIC_READ=true` použito v interním/lab režimu, web musí mít
`VITE_SIM_PUBLIC_READ_ENABLED=true`; pro internetový profil zůstává `false`.
