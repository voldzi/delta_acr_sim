# AI Router — skutečný Root/SQL test 15. 10. 2026

**14/14 nových skupin prošlo** v izolovaném Linuxu arm64, Node 24.20.0 a
PostgreSQL 18.6, `07:37:09.595Z–07:37:14.976Z`.
[Úplný receipt](2026-10-15_AI_ROOT_CHECKPOINT.json) má SHA-256
`afb73435faaaa2129e8e270c1266a431099c54bb25681ec8ba10b903b10f16cc`.
Piny všech SQL, Root modulů, kompilované aplikace, závislostí a obou
existujících neměnných obrazů jsou v receiptu.

## Ověřený rozsah

Test použil skutečné SQL 001–005, Root-owned soubory, Ed25519 podpisy,
kontrolu TLS CA/server name, PostgreSQL a zkompilované Router stores a
HTTP aplikaci. Nebyl nahrazen databázový klient ani kladný verifier.
Úspěšný callback desetkrát skutečně přešel přes Root reader a ověřil
podepsaný výsledek přesného checkpointu.

- Legacy checkpoint digests odpovídají skutečné aplikaci při daném
  search path. Privátní fakta jsou read-only.
- SQL005 má úzké sloupcové ACL, odmítá zastaralý CAS, přechází do karantény
  a zpět s další generací; starý privilege pin je neplatný. Ne-checkpoint
  řádky přitom zůstaly beze změny.
- Změna RLS, fence triggeru, finančního view, runtime column grantu,
  inkarnace nebo snapshotu se odmítne.
- Podvržený/prošlý podpis, neodpovídající peer, změněný signer/keyring,
  chybné cost evidence a odlišný frontier/živý proof se odmítnou.
- Čtení nevrací surový klíč, účet ani ledger řádky a nemění aplikační nebo
  registry data. Trvalé per-read identity se nevytvářejí.
- Skutečná BYOK key/chat cesta funguje při `accountErasureEnabled=false`,
  pokud je Root checkpoint platný. Klíč se uloží šifrovaně, tokeny a
  odhad nákladů se zaevidují. Prošlý nebo odvolaný Root důkaz vrátí 503
  před voláním poskytovatele nebo změnou dat.

## Co test nedokládá

Peer a metadata registry jsou výslovně syntetické fixture, nikoli
kernelová registrace nebo skutečný produkční enrollment. Dvě odpovědi
poskytovatele jsou syntetické; **žádné externí OpenAI volání** ani
skutečné účtování neproběhlo. Negativní keyring případy nejsou
deterministický souběžný test rotace během podpisu. Produkční Root
config/generation lease zůstává samostatnou podmínkou.

Test předchází přidání produkčního composition loaderu
`apps/ai-router-api/src/owner-checkpoint.ts`; jeho nové unit testy nejsou
součástí těchto čtrnácti skupin. Receipt neopravňuje tvrdit, že byl přijat
produkční nativní transport, publisher, obnova zálohy nebo cutover.
Žádný skutečný účet nebyl smazán, produkce ani chat nebyly přepnuty.

## Izolace a úklid

Pouze dva nové vlastní kontejnery: zdrojový Node kontejner nebyl spuštěn,
testovací PostgreSQL kontejner měl `--network none`, žádný host bind mount,
veřejný port nebo privilegovaný režim. Použity jen již místní obrazy,
bez pull/build. Oba kontejnery, jejich vlastní svazky i zdrojový kontext
byly odstraněny; samostatná kontrola přesného testovacího labelu byla
prázdná. Dva dřívější pokusy skončily při balení závislostí před vytvořením
kontejnerů; nevytvořily kladný receipt a jejich soukromé kontexty byly
odstraněny. Neproběhl globální prune.
