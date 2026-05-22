# Provider Documentation

Tato sekce je veřejný, source-neutral popis toho, jak má SIM nebo jiný poskytovatel dat dodávat mapové vrstvy do centrální zobrazovací aplikace COM.

COP je aktuální implementace COM. Historické názvy endpointů obsahující `cop` zůstávají jen jako kompatibilní server-side streamy pro existující backend adaptéry.

## Dokumenty

- [01_PUBLIC_PROVIDER_MODEL.md](01_PUBLIC_PROVIDER_MODEL.md)
- [02_MAP_CATALOG_PROVIDER_CONTRACT.md](02_MAP_CATALOG_PROVIDER_CONTRACT.md)
- [03_COMPATIBILITY_AND_LEGACY.md](03_COMPATIBILITY_AND_LEGACY.md)

## Stabilní vstupy SIM providera

- situation discovery: `GET /situation-data/api/v1/catalog`
- safety discovery: `GET /safety-data/api/v1/catalog`
- flight discovery: `GET /flight-data/api/v1/catalog`
- TAK/partner discovery: `GET /tak-gateway/api/v1/catalog`
- situation features: `GET /situation-data/api/v1/features`
- safety features: `GET /safety-data/api/v1/features`
- TAK/partner features: `GET /tak-gateway/api/v1/features`
- flight positions: `GET /flight-data/api/v1/aircraft/positions`

Tyto endpointy jsou provider API pro backend COM. Veřejný webový nebo mobilní klient COM má volat pouze COM API, typicky `GET /api/v1/map/catalog` a `POST /api/v1/map/query`.
