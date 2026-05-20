# Vyhodnocení open-data zdrojů pro situační obraz

SIM má poskytovat COPu doplňkové vrstvy, které rozšiřují vzdušný obraz o pozemní, síťový, dopravní a meteorologický kontext. Tyto vrstvy nejsou náhradou operačních systémů složek IZS ani garantovaným vojenským zdrojem. V pilotu slouží pro testování integrace, vizualizace a práce s kvalitou dat.

## Doporučené zdroje pro pilot

| Vrstva | Zdroj | Stav pro pilot | Licence / omezení |
| --- | --- | --- | --- |
| `weather` | Open-Meteo Forecast API | vhodné jako první live zdroj bez klíče | Free API je nekomerční, data pod CC BY 4.0 podmínkami, komerční použití přes placený tarif |
| `ground` | OpenStreetMap přes Overpass API | vhodné pro malé bbox dotazy a referenční POI | ODbL 1.0, atribuce a share-alike povinnosti pro databáze; veřejné Overpass instance mají fair-use limity |
| `mobile` | ČTÚ otevřená data, ČTÚ-NetTest, mapa internetu, OpenCellID, M-Lab | vhodné pro referenční a periodické vrstvy, ne pro real-time výpadky operátorů | ČTÚ metadata uvádí licenci u datasetu, často CC BY 4.0; OpenCellID CC BY-SA 4.0; M-Lab CC0 |
| `traffic` | JSDI/NDIC/DATEX II, PID GTFS/GTFS-RT | vhodné pro dopravní kontext po dopracování konektorů | podmínky je nutné ověřit pro konkrétní distribuci a způsob odběru |

## Důležité omezení mobilní sítě

Veřejný real-time zdroj stavu BTS nebo aktuálních výpadků mobilních operátorů typicky neexistuje jako otevřený datový kanál. Pro pilot lze použít:

- historická/stacionární měření ČTÚ,
- pokrytí a deklarovanou dostupnost,
- OpenCellID jako hrubý registr buněk,
- M-Lab/ČTÚ-NetTest jako měření výkonu sítě,
- vlastní měřicí body, routery, modemy nebo telefony hlásící RSRP/RSRQ/SINR, latency a packet loss.

## Zdroje ověřené k 2026-05-20

- Open-Meteo Terms: https://open-meteo.com/en/terms
- Open-Meteo API docs: https://open-meteo.com/en/docs
- OpenStreetMap attribution/licence: https://osmfoundation.org/wiki/Licence/Attribution_Guidelines
- Overpass API: https://wiki.openstreetmap.org/wiki/Overpass_API
- ČTÚ Open Data API: https://data.ctu.gov.cz/api
- ČTÚ mobilní sítě: https://data.ctu.gov.cz/tags/mobilni-site
- ČTÚ NetTest dataset detail: https://data.ctu.gov.cz/dataset/nettest
- OpenCellID licence: https://wiki.opencellid.org/wiki/Licensing:
- M-Lab FAQ/licence: https://www.measurementlab.net/frequently-asked-questions/
- PID Open Data: https://pid.cz/o-systemu/opendata/
