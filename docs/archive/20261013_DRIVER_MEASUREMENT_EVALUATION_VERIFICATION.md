# Ověření evaluace měření — 13. 10. 2026

Zdroj: větev `codex/driver-speed-pilot`, základ
`03b842e005f103bb02d622bb4fc95f27fbea9572`. Rozsah je dostupnost dobrovolného
sběru běžným účtům řízená COP, chráněné výsledky v SIM a porovnávací příprava.
Žádný traffic writer, provider interval, síť, secret, DB schema ani ETA
nebyl touto zdrojovou změnou přepnut.

## Provedené lokální kontroly

- Kompletní `pnpm typecheck`, `pnpm build` a skeleton: PASS.
- Regresní `pnpm test`: 655 PASS, 11 DB testů bez explicitní test URL SKIP.
  Zástupné test skripty některých balíčků nejsou browserová akceptace.
- Stejných 11 DB testů: samostatně PASS nad skutečným dočasným loopback-only
  PostgreSQL přes `scripts/test-driver-measurements-postgres.sh`. Server a jeho
  data byly odstraněny. Produkční DB ani přihlašovací údaje nebyly použity.
- Deterministická DB bariéra zařadila zápis za čekající revokaci. Revokace
  dokončila DELETE; následný zápis vrátil `DRIVER_CONSENT_REVOKED`, tabulky
  receipts a intervalů zůstaly prázdné. Samostatný HTTP test pozastavil matcher,
  dokončil DELETE 200 a poté potvrdil pozdní upload 403.
- DTO/publisher/reader: striktní scalars, zákaz raw GPS/identity/edge IDs,
  symlink/hardlink a práva, epoch invalidace a nový post-delete snapshot,
  odstranění staré publikace při chybě reloadu, zavření publisheru, chybějící
  data, zlomkové stáří, 90s zastarání a původní 5min deadline: PASS.
- Aktivní graf se ověřuje před i po konzistentním DB čtení; rotace vrací 503.
- Skutečné operátorské HTTP odpovědi 200/400/401/403 jsou ověřené vůči binding
  OpenAPI; public-read nepovoluje soukromý přehled. Provider fetch se nekoná.
- Čistý selector: prahy 5/10, graf/směr, původní okno, strop a rozptyl,
  přednost oficiálního zdroje, neznámé pokrytí a neměnný live count 0: PASS.
- OpenAPI build/validate/lint a diff-check: PASS; původní warnings nejsou
  důkazem chyby ani fyzické/geografické akceptace.
- Závěrečný offline cached lint uvádí 22 warnings mimo nový measurement
  kontrakt (odlišná verze linteru může počet změnit); žádné lint errors.
- Chroma retrieval našel relevantní kontrakt v hlavním projektu, ale file
  context a reindex nového worktree selhaly. CLI bez náhradní identity jej
  odmítl jako nevybraný projekt. Použita přímá cílená kontrola zdrojů; hlavní
  dirty projekt nebyl místo něj reindexován.

## Provozní hranice této evidence

Read-only kontrola potvrdila nezměněné tři SIM container/image identity;
SDA má revizi uvedeného základu. Serverový checkout je starší a dirty;
jeho observability/Compose/Nginx změny a soukromé soubory se musí zachovat.
Zdroj API/web mezi jeho základem a 03b byl porovnán bez rozdílu.
X5 má správný UUID a 54 GiB volného místa, ale nová cache složka chybí a
nadřazený adresář vlastní root. Je vyžádáno pouze její bezpečné vytvoření;
nezapisovat místo ní na interní disk.

Sdílený infrastrukturní HOLD skončil. Před produkční změnou zbývá aktuální
preflight, konkrétní společný slot/piny COP, nasazené obrazy a funkční ověření
reportu i mazání. Jízda potřebuje klientské receipts, individuální souhlas
a akceptaci na skutečném iPhonu. Tento záznam není potvrzení jejich provedení.

Před živým doplňováním rychlostí dále chybí nový účelový souhlas, přesné
pozorovací časy, průjezd celé směrové hrany a čekání v koloně, nezávislost
přispěvatelů, autoritativní official coverage, durable revocation/writer ack
a nezávislá kontrola ETA. Starší shadow měření se do živého použití nepovyšují.
