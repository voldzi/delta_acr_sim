# Omezený Root podpis výsledku mutation čtení

Datum: 15. 10. 2026. Rozsah: výslovně schválený zdroj a izolované
syntetické testy. Produkční služby, databáze, práva, secrets, síť ani
příznaky se neměnily. Výsledek nezapíná mazání a není společnou akceptací
celého COP–SIM požadavku. Veřejný REST/OpenAPI kontrakt se nemění.

## Výsledek a neměnné zdroje

Nová samostatná sada prošla **9/9 skupinami** nad skutečným PostgreSQL,
WeakMap kontextem, podpisy, TLS a drženým session zámkem. Běh trval
13:14:58.408–13:15:10.411 UTC; samotné případy 13:15:00.811–13:15:09.924 UTC.
Úplný [JSON důkaz](2026-10-15_DRIVER_MUTATION_ADMISSION_ROOT.json) má SHA-256
`5496358e3496b4c846940a3916f49ed117d344093a9ac6d9e4211723638be0ca`.

| Zdroj | SHA-256 |
| --- | --- |
| `deploy/account-safety/root-owner-authority.mjs` | `09457545a9fa57ffd95507637efdde11c768a9561e42851b543b3f5406ee8f72` |
| `scripts/test-driver-mutation-admission.mts` | `2df9c1f4f6304720b6725f7bc0f2e51d915e1f457f239fb0a803c138641d03ac` |
| `scripts/fixtures/driver-mutation-admission/harness.mjs` | `47b515b2fc8f49eae072ca6af60fe7d3541216dfe65e69728e4027a76f588606` |

COP dependency closure je vybrána pouze z Git objektů revize
`17d52541b0e8bffc7217f680714cd73f607644b6`, nikoli z rozpracovaného stromu.
Nový runner používá připnuté bootstrap/helper prefixy historických sad,
ale jejich případy nespouští, výsledky nesčítá a receipts nepřepisuje.

## Přesně ověřené skupiny

1. Prázdný preflight a status mohou mít null operation digest; chybějící
   receipt se odmítá.
2. Skutečný SQL003 register/claim/execute a COMMIT vytvoří ledger. První
   post kontrola se starým preflight časem je správně odmítnuta. Oddělený
   syntetický intent pro již existující ledger umožní přesný v2 receipt.
   Není to pozitivní důkaz prvního ERASE ani automatické obnovení intentu.
3. Kopie kontextu, jiný owner a ordinary read purpose se odmítají.
4. Podepsaný syntetický pending checkpoint připouští scoped mutation
   podpis, ale běžné čtení zůstává blokované.
5. Odmítají se vadné reference, podpisy, klíče, UUID, účel, peer, owner,
   vazby na intent/autoritu/store/source/frontier i request/checkpoint.
   Skutečná chybná práva adresáře 0750 neprojdou; obnovení 0700 projde.
6. Skutečný vrácený podepsaný interval nepřekračuje žádný aktuální strop.
   Scope je samostatně ověřen jako nejkratší limit; scope nebo intent
   delší než pět sekund se odmítá.
7. Skutečně prošlý scope, intent a kontext neobnoví autoritu ani neuvolní
   zámek. Známé explicitní close jej následně uvolní.
8. Souběžná čtení se serializují pod přesně stejným TLS metadata backendem
   a exclusive 904214. Cílové transakce mají skutečný COMMIT a známý END;
   nemění se cílová data ani chráněné soubory a nevzniká další lease.
9. Skutečně blokované cílové spojení je ukončeno. Admission nevznikne,
   global HOLD a metadata lease zůstanou; close ani jiný owner jej neobejdou.

Nový `inspectDriverMutationAdmission(ctx,input)` přijímá přesně sedm
klíčů a vrací `{admission,record}`. Pevné cesty, přesné podepsané struktury,
rozdílné request digests a TTL pravidla jsou v [integraci 23](../integration/23_SIM_ACCOUNT_SAFETY_RUNTIME_PREPARATION.md#omezený-podpis-kontrolního-výsledku).
Nepřijímá callback, SQL klienta, vlastní facts ani volbu ownera. Nevydává
ordinary permit, nepotvrzuje report inventory, neobnovuje ani nezavírá
vypůjčený kontext. Původní facts-only API zůstává zachované.

## Hranice důkazu

Intent, scope, enrollment a host/app vstupy jsou syntetické, podepsané
skutečným issuerem. Skutečný COP intent producer, Root keeper, nativní
packet transport, HTTP a celý první ERASE nebyly provedeny. Kernel SELF
identita byla skutečná; přijetí produkčního peeru není tím prokázané.

Facts digest není nezávisle přepočítán mimo skutečný builder. Všechny
vrácené TTL stropy jsou kontrolované, ale target-proof a facts-age nebyly
samostatně nastaveny jako nejkratší limit. Disconnect není ztracený COMMIT
nebo neurčitý END; tyto situace nejsou tímto během doložené. Žádný externí
provider, reálný účet, jízda, enrollment nebo restore nebyl použit.

V1 intent nadále přesně váže původní čas na ledger `created_at`. Preflight
čas před prvním zápisem není tímto časem. Nesoulad se odmítá bez tolerance,
nového originu nebo tichého přepočtu manifestu. Trvalá A/B vazba a její
skutečný producent jsou další oddělená etapa. Common zatím neexportuje
`assertDriverMutationIntent`; chybějící helper se nesmí nahradit callbackem.

## Izolace, úklid a zaznamenané chyby

Použity byly pouze místně dostupné pevné obrazy Node 24.20 a PostgreSQL
18.6, vlastní nové kontejnery `network=none`, privátní tmpfs, bez pull/build,
host bindů, volumes a veřejných portů. Syntetický SQL003 seed běžel pouze
na vlastním privátním Unix socketu bez přidání grantů; Root čtení používá
skutečně ověřené TLS. Vlastní kontejnery i všechny odvozené pracovní
kontexty byly odstraněny. Následný dotaz pod přesným labelem nevrátil
žádný kontejner. Žádný globální prune neproběhl.

Dva první pokusy skončily před Dockerem na kontrolovaném balení zdrojů,
nikoli na bezpečnostním testu. [Záznam selhání](2026-10-15_DRIVER_MUTATION_ADMISSION_INITIAL_FAILURE.json)
uchovává příčinu: hledaná deklarace se vyskytovala i jako citovaný řetězec.
Oprava zpřesnila jediný očekávaný úsek; assertion zůstal zachován a signer
se neměnil. Teprve nový úplný běh vytvořil uvedený kladný JSON důkaz.

## Další společná akceptace, nikoli aktivace tímto commitem

COP musí navázat skutečný keeper/transport, původní durable origin a přesný
ledger čas. Pod stejnou skutečnou autoritou se musí ověřit souběh, opakování,
známý SQL drain a HOLD při nejistotě. Následuje nezávislé přijetí konkrétní
Root instalace/politik a startup/restore karantény včetně starších obrazů.
Do té doby se produkční práva, secrets a přepínače nemění. Běžné čtení
nesmí obejít pending a signed readback není potvrzení dokončeného mazání.

## Kontroly repozitáře

Po změně signeru prošly `pnpm typecheck`, `pnpm test` (873 PASS,
6 volitelných PostgreSQL SKIP) a `pnpm build`. Package smoke hláška
o prohlížeči není nová vizuální kontrola. Samostatných 9 skupin je navíc
výše uvedený izolovaný důkaz, nikoli součást běžných 873 testů.
Prošly také skeleton validace, kontrola diff whitespace a OpenAPI validace
(151 cest, 274 schémat). Chroma retrieval/reindex byl nedostupný kvůli
transportu a nesouhlasu nativní identity checkoutu; nic se kvůli tomu
nepřestavovalo a změny byly ověřeny přímo ve zdrojích.
