# Signed revoke a doménové wire helpery — ověření 15. 10. 2026

Skutečně spuštěná sada situation-data-api: **674 PASS, 6 SKIP,
celkem 680**, 29 souborů PASS a jeden opt-in PostgreSQL soubor SKIP.
Typecheck/build a závazné OpenAPI prošly: 151 paths, 274 schemas.
Proti předchozímu publication checkpointu přibylo 35 signed-claim
případů a dva HTTP případy; jsou zahrnuty v 674, nikoli navíc.
První celý běh odhalil dvě starší guarded revoke fixtures bez nových
hlaviček. Po doplnění skutečného syntetického signed actoru prošel celý
finální běh; původní 401 nebylo obcházeno změkčením ochrany.

Samostatně, mimo tuto API sadu, prošlo **30/30 pure owner-domain skupin**
(Driver 14, AI 16) přes skutečné připnuté compiled/pure sourozence.
Reprodukovatelný runner je `scripts/test-account-safety-owner-domains.mjs`.
Samostatný prvotní staging i nový reprodukovatelný běh nejsou počítány
jako 60 případů. Tyto testy nejsou actual SQL, Root, native transport,
lease, enrollment, restore ani produkční akceptace.

## Přesná změna

- Guarded revoke po službovém auth a body validaci vyžaduje canonical
  osmipolový actor s `aud=sim-driver-revocation`, TTL <=60 s, konkrétním
  UTC dnem, shodným denním ID a zdrojem `verified_session|consent_ledger`.
  Chybějící/neplatný actor vrací 401 před Root context/SQL; validní actor
  bez skutečného Root kontextu 503. Tělo bez správného tvaru zůstává 400.
- Použije existující serverový actor secret/issuer. Nový pure helper
  neověřuje skutečný consent ledger, původ daily ID ani accountMAC;
  tyto nezávislé kontroly musí provést skutečný Root common.
- Legacy headerless režim před cutoverem se nemění. Denní revoke není
  account-deletion fence, nevytváří nový klíč ani nemaže sdílenou identitu.
- Root-domain Driver helpery sestaví přesná transientní revoke/erase/
  ACK/expire těla se stejnými HMAC pravidly jako skutečné app helpery.
  ACK jen přenese explicitní typed context; nevytváří report inventory
  nebo tvrzení `no_report`. Origin/cutoff/permit nejsou app parametry.
- AI helper sestaví pouze SQL005 wire body 14→13 polí: přesná bigint
  generace +1, TTL <=30 s, původní snapshot, schema/privilege piny a
  oddělené konzistentní active/quarantine stavy. Neověřuje skutečný
  původ transition ani její Root maintenance lease a sám nic nepublikuje.

## Použité skutečné pure bajty

| Artefakt | SHA-256 |
| --- | --- |
| Compiled Driver erasure, beze změny | `d184e31dda5484d4d8d2382208834197247ff47a1a37437f4f0550fdd95ea999` |
| Compiled signed revoke | `43116e10d8616f1320593b32a76dfdb7c15f6718f8b17e1f3b84bfc40efbe7fa` |
| Driver owner-domain | `ed0b8aa9543cd5daa54c53b8b22d6cc84d763c1c436833b3bb64bc3049f96651` |
| AI owner-domain | `2f8ee0a7496451d8bb257f1252a63c2872f22ed3e043592cb5480cd8a2eaf7f7` |
| AI checkpoint facts | `bcc476814331e1bf4fc68e552f8f4ca28f3b61a1ca32ebf7d6fbdbc6ef8d183f` |

## Otevřené skutečné gates

COP dodal pouze deklaraci `root-owner-authority.d.mts`; ta není skutečná
implementace ani důkaz. Stále chybí přijaté Root owner pluginy a actual
common ověření journal identity/consent, report inventory, held publikace,
target profily, role/instalace/enrollment a společný restore/replay test.
Pouhá shoda parserů nebo reference není kladnou autoritou.

Produkce se nezměnila, žádné skutečné účty nebo měření nebyly smazány,
secrets se nečetly ani nekopírovaly a neproběhlo OpenAI/provider volání.
Celá monorepo sada se neopakovala. Chroma není dostupné kvůli repo
identity odmítnutí a nebylo obcházeno.
