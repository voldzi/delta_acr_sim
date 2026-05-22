# Compatibility And Legacy

## Co je kanonické

Nová integrace má používat source-neutral COM model:

- COM klient: `GET /api/v1/map/catalog`
- COM klient: `POST /api/v1/map/query`
- SIM provider discovery: `GET /situation-data/api/v1/catalog`
- SIM provider data streamy: neutrální `/api/v1/features`, `/api/v1/aircraft/positions` a chráněné partner streamy

## Co zůstává jen kvůli kompatibilitě

Tyto SIM endpointy zůstávají dočasně aktivní, protože je může používat aktuální server-side COM adapter:

- `/situation-data/api/v1/cop/features`
- `/safety-data/api/v1/cop/features`
- `/tak-gateway/api/v1/cop/features`
- `/flight-data/api/v1/cop/tracks`

Nejsou určené pro veřejný webový klient, mobilní klient ani pro nové poskytovatele dat.

## Odstraněné legacy dokumenty

Historické realizační prompty a COP display návody byly odstraněny z veřejné dokumentace. Neobsahovaly stabilní API kontrakt pro nové poskytovatele a mohly vést k přímému volání provider endpointů z klienta.

## Migrační pravidlo

Pokud se objeví starý odkaz na `/cop/*`, nepřidávej ho do nového klienta. Buď:

- použij COM `/api/v1/map/catalog` a `/api/v1/map/query`, nebo
- doplň server-side COM adapter pro nový provider stream.
