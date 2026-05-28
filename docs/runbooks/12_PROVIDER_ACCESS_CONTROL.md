# Provider access control

**Status:** production baseline

## Goal

SIM is a server-to-server provider for the COP backend. It is not a public browser API and it is not a second public frontend.

Public internet access to `sim.zeleznalady.cz` is intentionally limited to:

- `GET /health/live`
- `GET /docs/`
- static manifest/icon files needed by the provider notice

Everything else is private provider or operator surface and must be reachable only from trusted internal networks, VPN, or explicitly allowed COP backend hosts.

## Docker-side protection

`sim-web` Nginx enforces internal-only access for:

- `/`
- `/api/*`
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

    location = /docs {
        return 301 /docs/;
    }

    location /docs/ {
        proxy_pass http://docker.home.cz:5020;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location = /site.webmanifest {
        proxy_pass http://docker.home.cz:5020/site.webmanifest;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location ~ ^/(api|flight-data|situation-data|safety-data|tak-gateway|health|metrics)(/|$) {
        return 403;
    }

    location / {
        return 403;
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
curl -i https://sim.zeleznalady.cz/docs/
curl -i https://sim.zeleznalady.cz/situation-data/api/v1/catalog
curl -i https://sim.zeleznalady.cz/
```

Expected public result:

- `/health/live`: `200`
- `/docs/`: `200`
- provider paths and `/`: `403`

