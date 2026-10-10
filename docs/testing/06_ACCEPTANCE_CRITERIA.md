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

## Krizové veřejné zdroje a mediální kontext

- News endpoint se volá pouze COP backendem, zobrazuje atribuci ČT24 a
  nepřidává safety geometrii, event čas, články, AI nebo notifikace.
- Osm regionálních/obecních feedů je omezený katalog, nikoli plošné pokrytí IZS;
  runtime konfigurace a source stavy musí být doložené zvlášť.
- Odhadované body autority/centroidy a obecné RSS nesmějí vytvářet radius-push
  kandidáty; explicitní event interval a původ polohy nejsou publikace článku.
- COP pro automatické vyhodnocení vyžaduje `inputReadiness.status=ready`,
  odvolatelný opt-in, AOI a vlastní oprávnění. Chybějící metadata, degradace a
  známá truncation fail-closed zabrání novému automatickému doručení.
- Kandidátní unit/contract testy, instalovaná image, aktivovaná konfigurace,
  živý interní smoke a skutečné doručení na zařízení se vykazují jako oddělené
  gates; tato změna sama neprokazuje background push.

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

## Kvalita verze 1.0

- `pnpm format:check` musí projít nad zdrojovým kódem, package konfigurací a skripty
- `pnpm verify` musí projít před produkčním nasazením nebo musí být výslovně popsán blokující důvod
- generované a archivní artefakty zůstávají mimo Prettier gate přes `.prettierignore`
