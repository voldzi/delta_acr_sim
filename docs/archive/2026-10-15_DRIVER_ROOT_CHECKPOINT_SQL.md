# Driver Root checkpoint — nové SQL ověření 15. 10. 2026

Výsledek: **8/8 nových skupin prošlo** v samostatném, dočasném PostgreSQL
18.3 clusteru od `07:21:49.965Z` do `07:21:52.291Z`.
[Strojový receipt](2026-10-15_DRIVER_ROOT_CHECKPOINT_SQL.json) má SHA-256
`295a4123a9ecc8c1c4cfe697aa8dcdd0eba1486c56018bd6cfc53e883adc3b54`.

Ověřen byl pouze nový privátní metadata publisher
`deploy/driver-measurements/005_root_checkpoint.sql`, SHA-256
`77faac125f6133a774e6d9e900c2dcbfc3b86419d3179bfb4d5bcf64eb3bb3cb`.
Testovací skript `scripts/test-driver-root-checkpoint-postgres.mts` má SHA-256
`7aadf226dc7733d5345e7f4c227ed21222dacace781f716d2e71d8ceb6b6d9a1`.

## Co bylo skutečně ověřeno

- Pevný control účet smí volat RPC; runtime ani executor nesmějí měnit
  metadata, převzít control roli nebo RPC vykonat. Owner má pouze šest
  sloupcových UPDATE grantů, nikoli table-wide UPDATE.
- Přesný dvanáctipoložkový vstup odmítá neznámé klíče, chybné typy,
  nekanonický čas a smíšený aktivní/karanténní režim.
- První skutečný NULL CAS, další CAS, chybná inkarnace a zastaralý
  checkpoint mají očekávaný výsledek. Dva souběžné CAS mají právě jednoho
  vítěze.
- Prošlý nebo příliš vzdálený důkaz a skutečný jednosekundový timeout
  řádkového zámku nezanechají změnu. Platnost se kontroluje i po čekání.
- Karanténa nesplní kladnou read policy. Změna privátní funkce/grantů
  změní privilege fingerprint; starý nezávislý pin je odmítnut.
- Ostatní data, ledger, fences, originy i store binding zůstaly stejné.
  Reference Root záznamu se neuložila do databáze.

## Hranice důkazu

Nový cluster poslouchal pouze na soukromém Unix socketu, bez TCP,
produkčních přístupů, secrets nebo poskytovatelů. Po testu byl odstraněn.
Předchozí zmrazené výsledky 11/14/15/18 případů byly pouze připnuté,
neopakované a nepřičítané.

Typovaná reference a databázové příznaky nejsou ověření podpisu ani
nezávislá autorita obnovy. Tento test nedokládá Root enrollment, skutečný
publisher, nativní transport, přijetí obnovy nebo nasazení. Produkce nebyla
změněna a žádný skutečný účet nebyl smazán.
