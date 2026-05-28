# Fire Data Sources for Czechia

**Status:** Implementovano pro pilot v Safety Data API.

SIM publikuje pozarni kontext pres katalogovou vrstvu `public.safety.fire`. Vrstva rozlisuje dva typy informaci:

- potvrzene nebo pravdepodobne tepelne anomalie / aktivni pozary,
- meteorologicke pozarni nebezpeci.

Tyto informace nejsou nahradou za oficialni krizovou komunikaci HZS/IZS.

## Pouzite zdroje

### CHMI CAP fire danger

- Zdroj: `https://opendata.chmi.cz/meteorology/weather/alerts/cap/`
- SIM source: `chmi_alerts`
- Vrstva: `public.safety.fire`
- Kategorie: `fire_weather_risk`
- Typ geometrie: `Polygon` nebo `MultiPolygon`, pokud lze CAP `CISORP`/`EMMA_ID` sparovat na lokalni PostGIS administrativni hranice.
- Stav: `fireStatus=risk`, `status=risk`

CHMI CAP vystrahy typu `Nebezpeci pozaru` nebo `Vysoke nebezpeci pozaru` jsou oficialni meteorologicke riziko pro CR. SIM je uz publikuje take ve vrstve `public.safety.weather_alerts`; projekce do `public.safety.fire` slouzi k tomu, aby COM dokazal zobrazit pozarni rizika v jedne pozarni vrstve.

### NASA FIRMS

- Zdroj: `https://firms.modaps.eosdis.nasa.gov/`
- SIM source: `nasa_firms`
- Vrstva: `public.safety.fire`
- Kategorie: `active_fire`
- Typ geometrie: `Point`
- Stav: `fireStatus=detected`, `status=active`
- Vyuziti: satelitni detekce aktivnich pozaru a tepelnych anomalie.

NASA FIRMS vyzaduje `NASA_FIRMS_MAP_KEY`. SIM bez klice zdroj nevola. Odpovedi jsou cachovane na source-level, aby COM klienti nikdy nezatezovali FIRMS primo.

## Zdroje vyhodnocene pro dalsi faze

### HZS CR denni hlaseni

- Zdroj: `https://hzscr.gov.cz/hasicien/docDetail.aspx?docType=ART&docid=26655`
- Typ: oficialni denni hlaseni udalosti a zavaznych pozaru.
- Stav: zatim neimplementovat jako realtime mapovou vrstvu.

HZS CR publikuje prubezna aktualni data o mimoradnych udalostech a pozarech platna ke dni a hodine generovani. Data jsou vhodna pro overovani a statisticky kontext, ale nejsou stabilni geolokacni API pro tisice runtime dotazu COM.

### EFFIS / Copernicus

- Zdroj: `https://forest-fire.emergency.copernicus.eu`
- Typ: evropsky pozarni system, aktivni pozary, spaleniste, pozarni nebezpeci, historicke datove sady.
- Stav: vhodne pro doplneni evropskeho kontextu a fuel/fire danger dat, az bude vyjasnen stabilni endpoint a licencni model pro runtime pouziti.

Copernicus deklaruje vetsinu dat jako free, full and open. EFFIS data jsou relevantni pro Evropu, ale pro pilot je jednodussi a robustnejsi kombinace CHMI CAP + NASA FIRMS.

### FireWatch CZ

- Zdroj: `https://firewatchcz.cz/`
- Typ: neoficialni soukromy analyticky projekt s verejnym prehledem udalosti JPO.
- Stav: nezapojovat bez dohody s provozovatelem.

Projekt sam uvadi, ze nejde o oficialni system HZS/JPO/IZS a data maji orientacni analyticky charakter. Pro SIM je to kandidat jen pro partnerstvi, ne pro automaticky scraping.

## Kontrakt pro COM

COM ma pro `public.safety.fire` pocitat s:

- `hazardType=fire` pro aktivni hotspoty,
- `hazardType=fire_weather` pro pozarni nebezpeci,
- `fireStatus=detected` nebo `fireStatus=risk`,
- `sourceId=nasa_firms` nebo `sourceId=chmi_alerts`,
- `sourceName` rozlisujicim satelitni detekci a CHMI vystrahu,
- `confidence`, `severity`, `urgency`, `certainty`,
- `metrics.frp` pro FIRMS, pokud existuje,
- `metrics.fireRiskFromWeatherWarning=true` pro CHMI CAP pozarni riziko.

COM nema dotazovat NASA FIRMS, CHMI, HZS ani FireWatch primo. COM vola SIM katalog a bbox query.
