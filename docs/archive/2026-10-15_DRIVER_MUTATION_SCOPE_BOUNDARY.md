# Mutation facts a privátní v2 aplikační hranice

Datum: 15. 10. 2026. Rozsah: zdroj a izolované syntetické testy.
Produkční služby, databáze, migrační práva, secrets, síť a příznaky nebyly
změněny. Mazání není tímto výsledkem aktivované. Veřejný OpenAPI se nemění.

## Co je ověřeno

| Samostatná sada | Výsledek | Hranice důkazu |
| --- | --- | --- |
| Guarded store | 30/30 | Syntetické porty + skutečný čistý matcher, první preflight, povinný receipt a shodný owned scope před/po dispatchi |
| Guarded runner/admission | 41/41 | Syntetické porty, immutable snapshot, oddělení scopes, probe-only retry, zákaz v2/v1 downgrade a getterů/proxy |
| HTTP composition | 29/29 | Syntetický response/port, synchronní AbortSignal při finish/close, oddělené controllery, žádný TTL release nebo tvrzení o Root drain |
| [Root mutation facts](2026-10-15_DRIVER_MUTATION_FACTS_ROOT.json) | 8/8 | Skutečný WeakMap common, podpisy, TLS, SQL, jedna držená metadata session, expirace a HOLD při skutečném target disconnect |

Aplikační sady nepotvrzují chráněný port, Root keeper ani nativní transport.
Root sada naopak nepotvrzuje veřejný HTTP tok, skutečný COP intent producer,
nový scoped admission podpis, produkční enrollment nebo obnovu. Počet osmi
skupin se nesčítá s historickými common 22, lineage 8 nebo refresh 6.

Nový JSON receipt má SHA-256
`a75d5ef96937321a2f19617a884482edf95cb451f23b2f34b3fb95650384b06d`.
Běh trval 12:30:46.466–12:30:56.171 UTC. Připíná common
`501d8a638b442250d64905f66a182de6a82296cd2324a4e63ac888eee209b4f4`,
runner `3120dac5729ec8671f057929eccbd59d2886e122d399e4dc71bbb4b30986748d`
a fixture `2162f54f229d7333f13787b3b0f63e11fcc0dc03851662297e6ac7f86f58b9b9`.
Úplné piny importů, SQL, generovaného bootstrapu a předchozích neměnných
receipts jsou v JSON. COP closure pochází jen z neměnných Git objektů
`17d52541b0e8bffc7217f680714cd73f607644b6`, nikoli z rozpracovaného stromu.

## Osm skutečných skupin

1. Prázdný preflight a status projdou; chybějící receipt se odmítne.
2. Skutečný SQL003 register/claim/execute a COMMIT vytvoří pozdější ledger
   čas. Původní předzápisový intent se správně odmítne. Samostatný nový
   syntetický intent pro již existující ledger odpovídá jeho přesnému času;
   vadný request hash, počet a čas o 1 ms se odmítnou. Nejde o přepočet nebo
   prodloužení původního intentu ani o pozitivní test celého prvního ERASE.
3. Vadný podpis/digest, peer, binding, druh a další klíč se odmítnou.
4. Kopie kontextu, AI owner a ordinary read účel nejsou mutation autorita.
5. Přijatý syntetický pending checkpoint připouští mutation facts, ale
   ordinary read zůstává blokované. Nevzniká plošná read výjimka.
6. Dvě současná volání se serializují pod přesně stejným TLS metadata
   backendem a skutečným exclusive 904214. Target sessions skutečně skončí
   před návratem. Metadata, cílová public data a chráněné soubory se nemění;
   helper nevydá nový signed admission/permit ani neotevře druhou lease.
7. Skutečné expirace intentu i původního kontextu odmítnou novou práci,
   nic neobnoví a samy neodemknou lease. Známé explicitní close ji uvolní.
8. Skutečně zablokovaný target backend je ukončen, common ponechá global
   HOLD a metadata session; close ani jiný owner nezačne novou práci.

Target disconnect není simulace ztraceného COMMIT ani neurčitého END.
Tyto dvě vlastnosti receipt výslovně označuje jako netestované.
Raw principal, skutečná jízda, produkční účet ani poskytovatel se nepoužily.

## Izolace a úklid

Použity byly pouze již místně dostupné pevné obrazy Node 24.20 a PostgreSQL
18.6, vlastní nové kontejnery s `network=none`, bez image pull/build,
host bindů, volumes a veřejných portů. PG data i privátní Root záznamy
byly na tmpfs. Root facts používal skutečně ověřené TLS; pomocný syntetický
SQL003 executor seed použil vlastní privátní Unix socket bez přidání grantů.
Host/app observations, přijaté enrollment podklady a mutation intents byly
syntetické vstupy podepsané skutečným issuerem; kernel SELF byl skutečný.

Oba vlastní kontejnery i pracovní kontexty byly odstraněny. Následný dotaz
pod přesným testovým labelem nevrátil žádný kontejner. Globální prune,
produkční soubory ani staré testové receipts nebyly změněny.

## Zbývající bezpečnostní kroky

Nový scoped Root signer nebyl aplikován: automatická kontrola vyžádala
výslovný souhlas s konkrétním rozšířením privilegovaného podepisování.
Odmítnutí se neobcházelo jiným patchem, nástrojem ani kladnou náhradou.
Člověku byl předložen úzký dotaz pouze pro zdroj a izolované testy.

Po potvrzení zůstává nutné doplnit a skutečně ověřit podpis, Root keeper,
v2 transport i původní business anchor navázaný na známý origin a skutečný
ledger. Přesný starý origin, tělo, checkpoint a deadline se nesmějí změnit
při retry. Následná instalace a produkční aktivace stále vyžaduje skutečné
vazby/politiky, startup/restore karanténu a společnou COP–SIM akceptaci.
Žádná část tohoto záznamu neznamená, že zbývá pouze sudo nebo přepínač.

## Kontroly repozitáře

`pnpm typecheck`, `pnpm test` (873 PASS, 6 opt-in PostgreSQL SKIP) a
`pnpm build` prošly po poslední aplikační změně. Package smoke hláška
o prohlížeči není nový vizuální test. Skeleton a OpenAPI validace také
prošly; veřejný kontrakt má 151 cest a 274 schémat. Retrieval/reindex nebyl
obcházen: Chroma MCP selhalo a CLI odmítlo nesouhlas nativní identity
checkoutu. Opravy byly provedeny přímým ověřením zdrojů.
