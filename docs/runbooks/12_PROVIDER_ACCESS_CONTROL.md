# Provider access control

**Status:** production baseline

## Goal

SIM is a server-to-server provider for the COP backend and an optional public
operator console. The public console is not a provider API: it is a Keycloak
protected web UI that calls `/api/v1/*` with a browser bearer token and SIM
roles.

Public internet access to `sim.zeleznalady.cz` is intentionally limited to:

- static web UI assets and `/`,
- `/api/v1/*` through SIM API authentication and RBAC,
- `GET /health/live`,
- static manifest/icon files.

Everything else is private provider or diagnostics surface and must be reachable
only from trusted internal networks, VPN, or explicitly allowed COP backend
hosts.

## Docker-side protection

`sim-web` Nginx enforces internal-only access for:

- `/flight-data/api/*`
- `/flight-data/health/*`
- `/situation-data/api/*`
- `/situation-data/health/*`
- `/safety-data/api/*`
- `/safety-data/health/*`
- `/tak-gateway/api/*`
- `/tak-gateway/health/*`

The Nginx config trusts `X-Forwarded-For` only from RFC1918/CGNAT/internal reverse proxies via `set_real_ip_from`. This matters because requests forwarded by `dmz.home.cz` must be evaluated by the original public client IP, not by the DMZ host address.

Allowed by default:

- `127.0.0.1`, `::1`
- `10.0.0.0/8`
- `172.16.0.0/12`
- `192.168.0.0/16`
- `100.64.0.0/10`
- `fc00::/7`

If COP backend is moved to a non-private network, add that exact source range to `apps/simulator-web/nginx/internal-provider-access.conf` or enforce the allowlist at `dmz.home.cz`.

The same Nginx layer also protects the intentionally public paths:

- `GET /health/live` is rate limited to `30r/m` per client IP with a short burst.
- `/api/*` is rate limited at the gateway and then authorized by the SIM API.
  Production internet profile must use `SIM_API_PUBLIC_READ=false`, so
  unauthenticated requests get `401`.
- Public static/provider-notice paths are rate limited to `240r/m` per client IP.
- Static hashed frontend assets and icons are cacheable; `index.html` and internal UI/provider responses are `no-store`.
- Responses include security headers from `apps/simulator-web/nginx/security-headers.conf`: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy` and a restrictive `Content-Security-Policy`.
- `client_max_body_size` is set to `1m`, matching the Express body parser limits used by the APIs.

## DMZ-side protection

Docker-side protection is a second line of defense. The primary internet boundary is `dmz.home.cz` Nginx. Its `sim.zeleznalady.cz` vhost should block provider paths before proxying them to `docker.home.cz:5020`.

Minimum public server block pattern:

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name sim.zeleznalady.cz;

    ssl_certificate     /etc/letsencrypt/live/sim.zeleznalady.cz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sim.zeleznalady.cz/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location = /health/live {
        proxy_pass http://docker.home.cz:5020/health/live;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location ~ ^/(flight-data|situation-data|safety-data|tak-gateway|health|metrics)(/|$) {
        return 403;
    }

    location /api/ {
        proxy_pass http://docker.home.cz:5020;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Authorization $http_authorization;
    }

    location = /site.webmanifest {
        proxy_pass http://docker.home.cz:5020/site.webmanifest;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location / {
        proxy_pass http://docker.home.cz:5020;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

If COP backend must call SIM through the public FQDN instead of the internal address, add a separate internal/VPN-only vhost or allowlist exact COP backend IPs at `dmz.home.cz`. Do not broadly allow the internet to provider paths.

## COP integration

COP backend should call one of these private provider base URLs:

```text
http://docker.home.cz:5020/situation-data/api/v1
http://docker.home.cz:5020/safety-data/api/v1
http://docker.home.cz:5020/flight-data
http://docker.home.cz:5020/tak-gateway/api/v1
```

COP frontend and mobile clients must call only COP endpoints, for example:

```text
GET /api/v1/map/catalog
POST /api/v1/map/query
```

## Verification

From an internal host or VPN:

```bash
curl -fsS http://docker.home.cz:5020/health/live
curl -fsS http://docker.home.cz:5020/situation-data/api/v1/catalog
curl -fsS 'http://docker.home.cz:5020/situation-data/api/v1/features?layers=weather&limit=1'
```

From the public internet:

```bash
curl -i https://sim.zeleznalady.cz/health/live
curl -i https://sim.zeleznalady.cz/
curl -i https://sim.zeleznalady.cz/api/v1/operations/summary
curl -i https://sim.zeleznalady.cz/situation-data/api/v1/catalog
```

Expected public result:

- `/health/live`: `200`
- `/`: `200` static UI, then Keycloak login gate in the browser
- `/api/v1/operations/summary` without bearer token: `401`
- provider paths: `403`
- response headers include `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`

Rate-limit smoke test from a non-critical host:

```bash
for i in $(seq 1 60); do curl -fsS -o /dev/null -w "%{http_code}\n" https://sim.zeleznalady.cz/health/live; done | sort | uniq -c
```

Expected result is mostly `200`, with `429` after the allowed public-health burst if the loop is fast enough.
