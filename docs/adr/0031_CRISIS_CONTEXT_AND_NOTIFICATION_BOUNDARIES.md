# ADR 0031: krizový mediální kontext oddělený od notifikačních kandidátů

## Status

Accepted and deployed in SIM, 2026-10-10. Testy a živá interní cesta COP–SIM
jsou ověřeny; podrobná identita obrazu a evidence jsou v kontraktu 21.
Uživatelský opt-in/AOI a skutečné background doručení COP jsou dosud samostatné
nepotvrzené gates.

## Context

SIM již normalizuje oficiální veřejná bezpečnostní data a regionální/obecní
feedy. Obecná aktualita, čas publikace článku, odhadovaný bod autority ani
odpověď ze stale cache však nejsou důkazem probíhající události pro konkrétní
uživatelskou oblast. ČT24 může doplnit orientační krizový kontext, ale nesmí
nepozorovaně vstoupit do bezpečnostních mapových prvků nebo automatických pushů.

## Decision

- Přidat oddělený server-to-server endpoint
  `GET /safety-data/api/v1/context/news` s kontraktem
  `sim-crisis-media-context-v1`. ČT24 není `SafetyDataSource` ani mapová vrstva.
- Povolit jen tři pevně definované oficiální RSS feedy ČT24. Uchovávat pouze
  krátký sanitizovaný titulek, odkaz, atribuci a metadata původu/času v paměti.
  Žádné články, obrázky, scraping, AI analýza nebo raw RSS persistence.
- `publishedAt` je čas publikace, `fetchedAt` čas načtení a `eventAt=null`.
  `regionCode` označuje pouze rozsah feedu (`regionScope=feed`), nikoli polohu
  události. `location=null`, `locationStatus=unresolved`,
  `informationalOnly=true`, `notificationEligible=false` jsou závazné.
- Akvizice probíhá až na serverový dotaz, s pětiminutovou sdílenou per-feed
  cache, coalescingem, negativním backoffem, timeoutem a limitem 1 MiB.
  Stale fallback se označuje explicitně. Konektor zůstává defaultně vypnutý.
- Osm vestavěných regionálních/obecních zdrojů je omezený katalog, ne tvrzení
  celostátního pokrytí IZS. Obecný RSS/Atom/GeoRSS/GeoJSON příspěvek se v
  aktuální normalizaci nikdy sám nestane notifikačně způsobilým.
- Regionální notifikační kandidát vyžaduje výslovnou pozitivní způsobilost,
  skutečnou zdrojovou polohu a aktivní explicitní interval události. Samotná
  publikace nebo syntetický konec snapshotu nestačí. Reprezentativní body,
  centroidy a fallback body autority nesmějí vytvářet radius-push kandidáty.
- Kandidátní HTTP endpoint vyhodnocuje `inputReadiness`. Při degradaci,
  stale/chybné cache, varování nebo dosažení známého limitu neposkytne
  automaticky použitelné kandidáty. Výsledek pod limitem není důkazem úplnosti
  upstreamu. COP musí pro automatické zpracování vyžadovat `status=ready`.
- COP vlastní uživatelský opt-in, AOI/geofence, oprávnění, konečné rozhodnutí a
  objednání doručení. CSM Messaging vlastní doručovací kanály a audit. SIM
  nedostává uživatelskou GPS, device tokeny ani preference a neslibuje nový
  background scheduler nebo kontinuální push službu.

## Consequences

Mediální kontext lze zobrazit s atribucí bez tvrzení přesné polohy nebo
aktuálního bezpečnostního zásahu. Konzervativní pravidla titulku mohou relevantní
zprávu vynechat a nemohou ověřit pravdivost či aktuálnost samotné události.
Omezené pokrytí zdrojů a fail-closed readiness mohou snížit počet kandidátů;
to je přijatelnější než odvozovat platnost a místo z článku či stale snapshotu.

## Alternatives Considered

- Promítat ČT24 do `public.safety.warnings`: odmítnuto, protože RSS článek není
  autoritativní safety událost a jeho region není souřadnice incidentu.
- Geokódovat text/obrázky nebo použít AI: mimo zvolený rozsah a bez spolehlivého
  důkazu polohy/platnosti; neimplementuje se.
- Odvozovat automatický push ze závažnosti titulku nebo cache stáří: odmítnuto;
  nezaručuje uživatelský vztah k události ani aktivní událost.

## Follow-up Actions

SIM konfigurace/image, interní provider cesta, regionální zdroje, news stavy a
automatický rollback byly ověřeny. Následně samostatně ověřit COP opt-in/AOI,
deduplikaci a skutečné doručení. Viz
[integrační kontrakt 21](../integration/21_CRISIS_CONTEXT_AND_REGIONAL_ALERTS_CONTRACT.md)
a [notifikační kontrakt 14](../integration/14_CSM_NOTIFICATION_INPUT_CONTRACT.md).
