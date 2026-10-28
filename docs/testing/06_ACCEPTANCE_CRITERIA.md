# Acceptance criteria

**Status:** Baseline dokumentace

## Funkční

- SIM běží samostatně mimo COP
- UI umožní vytvořit, spustit, pozastavit a zastavit scénář
- SIM generuje aircraft, UAV a missile tracks
- SIM umí dry-run
- všechna data jsou SYNTHETIC
- fault injection je dostupný
- health/metrics endpointy fungují

## AI

- provider abstraction pro OpenAI, Codex, local LLM a mock
- AI draft validovaný proti JSON Schema
- human confirmation před spuštěním
- zakázané požadavky odmítnuté a auditované
- externí AI lze vypnout

## Integrace

- sourceSystemId
- idempotency key
- retry/backoff
- batch sending
- 401/403/409/422/429/503 handling
- revokace zdroje bez změny kódu

## Výkonnost

- 1 000 aktivních tracků MVP
- 1 000 zpráv/s lab režim
- queue neztratí data při krátkodobém výpadku
- restart neztratí uložené scénáře
- SIM web splní bundle budget `pnpm build:budget`
- operations dashboard chrání interní provider dotazy timeoutem a limitem velikosti odpovědi `SIM_OPERATIONS_PROVIDER_MAX_RESPONSE_BYTES`

## Produkční routing dataset

- Valhalla kandidát se staví mimo aktivní produkční release
- `admins.sqlite` obsahuje ISO CZ, DE, PL, SK, AT a HU
- route, locate, isochrone a elevation projdou pro všech šest zemí s tvrdým
  `search_cutoff` a kontrolou skutečné snap vzdálenosti
- smíšené časy Geofabrik snapshotů nevytvoří duplicitní verze OSM objektů ve
  finálním extractu
- vadný kandidát nezmění `current`
- vynucené selhání aktivace obnoví a ověří předchozí release
- systemd timer je enabled a poslední pokus i úspěch jsou dohledatelné

### Jediná varianta plánované mapped automobilové trasy

Syntetická kontrola 2026-10-28 v `known-road-closures.test.ts` porovnává celý
nativní požadavek stejného profilu a uzávěr pro `alternatives: 1` a `3`.
Lišit se smí pouze `alternates: 0` versus `2`. Profil včetně rozměrů a hmotnosti,
`costing: auto`, všechny `ignore_*: false`, geometrie vyloučených uzávěr,
`shortest: false`, tolerance i ostatní volby zůstávají stejné. Vstup se nemění.
Varování 401 musí i pro jedinou variantu skončit ochrannou 422, bez opakování
nativního dotazu či fallbacku. Tato kontrola nemění runtime ani API kontrakt.

Příkaz `pnpm --filter @csm-sim/situation-data-api exec vitest run
test/mapped-road-profile.test.ts test/known-road-closures.test.ts` prošel:
116/116 testů (24 profilů + 92 uzávěr/routování). Veškerý upstream je nahrazen
syntetickými odpověďmi. Test potvrzuje serializaci a bezpečnostní podmínky,
nikoli vyřešení konkrétní trasy z přibližné polohy telefonu. Opravené chování
klienta vyžaduje samostatné ověření na skutečném telefonu bez tichého posunu
polohy, vypuštění profilu, zvýšení tolerance nebo aktivace navigace.

Pro tento krok nebyl dostupný lokální obraz Valhally ani izolovaný skutečný
český graf: srovnání nativního výsledku veřejné adresy s jednou/třemi variantami
neproběhlo. Žádný produkční požadavek nebyl kvůli těmto testům opakován.
Varování 401 je ve zdroji Valhalla 3.8.3 indikátorem druhého průchodu hledání;
samo neurčuje porušený zákaz ani původ/cíl. Viz přesný upstream
[get_path, commit a60c7cb](https://github.com/valhalla/valhalla/blob/a60c7cbfc83e073f50887cd27e0109d02e6b64e5/src/thor/route_action.cc#L424-L475).

## Kvalita verze 1.0

- `pnpm format:check` musí projít nad zdrojovým kódem, package konfigurací a skripty
- `pnpm verify` musí projít před produkčním nasazením nebo musí být výslovně popsán blokující důvod
- generované a archivní artefakty zůstávají mimo Prettier gate přes `.prettierignore`
