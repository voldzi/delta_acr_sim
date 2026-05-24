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

## SIM env

Pro pilot doporucujeme `hybrid`: Keycloak je primarni cesta a staticky `SIM_API_ADMIN_TOKEN` zustava jen jako nouzovy fallback.

```bash
SIM_API_AUTH_REQUIRED=true
SIM_API_PUBLIC_READ=true
SIM_API_AUTH_MODE=hybrid
SIM_API_ADMIN_TOKEN=<high-entropy-break-glass-token>

SIM_OIDC_ISSUER=https://login.zeleznalady.cz/realms/cop
SIM_OIDC_JWKS_URI=
SIM_OIDC_CLIENT_ID=csm-sim-web
SIM_OIDC_ALLOWED_CLIENTS=csm-sim-web

VITE_SIM_AUTH_MODE=hybrid
VITE_SIM_OIDC_ISSUER=https://login.zeleznalady.cz/realms/cop
VITE_SIM_OIDC_CLIENT_ID=csm-sim-web
VITE_SIM_OIDC_SCOPE=openid profile email
```

`SIM_API_AUTH_MODE=oidc` vypne staticke SIM tokeny a povoli pouze Keycloak JWT. Pouzij ho az po overeni, ze existuje alespon jeden spravce s roli `csm-sim-admin`.

## Chování v UI

SIM web pouziva Authorization Code + PKCE. Po prihlaseni posila access token jako `Authorization: Bearer <token>` na SIM API. Token neni vkladany do HTML ani do JavaScript bundle jako secret.

Read-only dashboard endpointy mohou zustat verejne pres `SIM_API_PUBLIC_READ=true`. Operacni akce jako start/stop scenare, fault injection, publisher queue a AI zmeny vyzaduji Keycloak roli nebo fallback token.
