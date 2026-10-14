# V5 offline shoda Node–Python — 14. 10. 2026

## Výsledek a přesná revize

SIM main agent nezávisle spustil zmrazený source commit
`6e73a303e6c6a4fd126b0dc381b6b36f1cc4c2bf`, tree
`b187e936fd29dbb399fc939b06bcdd3dfde216e6`, na Node 24.16.0.
Finální sada: **88 PASS, 0 FAIL**. Jeden bounded Python 3.14.6 proces
ověřil 60 čistých codec jobs; 17 výměn bylo pouze v paměti.
Žádný registry, native transport, SQLite, poskytovatel ani produkční
databáze nebyly testem použity. Všech šest Python audit counterů je 0.

[Strojová evidence a jednotlivé případy](2026-10-14_DORMANT_V5_CODEC_CONFORMANCE.json)
obsahují skutečný vlastní výstup runneru, nikoli součet historických sad.

| Soubor | SHA-256 |
| --- | --- |
| `scripts/test-dormant-fixture-companion.mts` | `95c9f1d1452b2d27812881c76c2d8aa928ab653320dfed1edb8d1312ae031b65` |
| `scripts/dormant-fixture-python-bridge.py` | `cb40d41f76221a3b311a9ecaeea07aa91eee6926a3b199312b8512d30f5f47fc` |
| `scripts/lib/dormant-fixture-json.mts` | `2e56df7c563f62ab0bfd14f90503249f2704cf4693d63d3ec9b7153b5dafa89d` |
| `scripts/lib/dormant-v5-fixture-client.mts` | `927fc8dcdbacc52727934405e7c472a22c46715e7235faa2a30a7d7ced3c242d` |

Externí `SOURCE-PINS.json` je připnutý na `90814725db2f78232d401fbdf83f6f5d99a16a146b67e648adfb76d4d018523f`;
Python boundary na `f0bffe6f0f6d3b26570050c2a0bcb59d27923e3a347f8967b9aba76240a859dd`.
Obě původní V5 schémata kompilují v strict Ajv2020 8.20.0 bez přepisování
nebo vzdáleného načítání. Test prověřuje čtyři emitované syntetické páry,
canonical bytes a oba digests, všech šest metod, přesné response vztahy,
chybné bytes/struktury, všech jedenáct false flags a bounded client.

## Co test skutečně kontroluje

- Python decoder a result/error encoder jsou skutečné připnuté funkce,
  nikoli jejich JS napodobenina. Registry/core/Boundary/native callbacks
  se nevolají. Rootův historical 34-case SQLite test se zde nespouští.
- Float a duplicate-key lexémy se odmítnou ještě před ztrátovým parsingem.
  Přímé helper případy ověřují přesné error codes i inclusive hranice;
  samotné odmítnutí neplatného DTO by takové limity neprokázalo.
- Proxy, accessor a toJSON se nevyvolají. Canonical helper je pro bezpečné
  ASCII DTO, ne obecný Unicode JCS ani validační důkaz identity.
- Permit lease ID, historical ACK, CAS scope a drain scope/count/state se
  vážou na původní požadavek. Opaque registry digests nejsou frame hash.
- Pre-abort nebo synchronní deadline před dispatch nevysílají nic.
  In-flight deadline/abort nedovolí pátou výměnu, dokud skutečná promise
  neskončí. Pozdní výsledek nezmění unknown na úspěch; není retry/fallback.

Timeout 5 sekund je omezení rodičovského testovacího procesu, nikoli
záruka nativního COMMIT. Node fetch counter není obecný síťový sandbox;
reviewed moduly proto nemají žádné síťové, databázové či aplikační importy.
Runner zachytí piny vlastních modulů před/po běhu; jejich přijaté hodnoty
jsou výslovně uvedeny výše a musí je znovu porovnat reviewer nové revize.

## Regrese a zachovaná historie

Workspace typecheck a build PASS, běžné testy **591 PASS / 6 SKIP / 0 FAIL**.
Skip je dosavadní opt-in PostgreSQL sada; jiných 41 historických SQL
kontrol se k tomuto počtu nepřičítá. 70 erasure schema případů, OpenAPI
build check/validate a skeleton/diff kontrola PASS. První typecheck pokus
skončil na globálním pnpm 11; opakování s child PATH pro pnpm 10.33.0 PASS,
bez instalace nebo změny závislostí.

OpenAPI zůstává beze změny: 151 cest / 273 schémat, SHA-256
`4509ff5bd9931a011805984895254d6b19e75bfef2e5fa2efdb8b28ad8d90992`.
Nové soubory jsou pouze pod `scripts`; aplikace, deploy, env příklady a
lockfile se nemění. Zmrazený v1 klient a jeho test mají stále původní
piny b78e3f69… / 6e7d1169…; jeho 61 případů není součástí V5 počtu.
V3, v4 a Root historické výsledky zůstávají samostatné.

Chroma reindex odmítl managed worktree identity (exit 2). Hlavní index
nebyl přepsán ani obejit; zdroje byly kontrolovány přímo.

## Co není hotové a další gate

`acceptedWire=false`, `productionReady=false` a všech jedenáct actual
flags zůstávají false. Neexistuje zde pozitivní verifier, skutečný
producer, přijatý runtime bootstrap, nezávislý anchor nebo restore test.
Žádný účet nebyl smazán a žádná produkční služba nebyla přepnuta.

Prázdná metadata DB z odděleného infrastrukturního G2 kroku není
per-principal fence store ani runtime authority. Poslední doložený
source preflight správce skončil na nevyřešeném entrypoint/config vztahu;
SIM vyžádal pouze úzké read-only doložení původu modulu a knihoven,
bez importu službového kódu, DCS requestu, reloadu nebo nových oprávnění.
Tento report netvrdí, že následná A1 inventura či A2 je dokončená.

Budoucí skutečný transport a jeho kernelové testy jsou [samostatný návrh](../integration/22_COP_ACCOUNT_ERASURE_CONTRACT.md#návrh-nejmenšího-nativního-transportu-pro-node).
Následuje konkrétně schválené infrastrukturní zřízení, skutečný identity/
owner binding, nezávislá restore ochrana a společná COP–SIM akceptace.
Dokud chybí, nové obrazy nesmějí přepnout chráněné běžné COP cesty ani
jen s vypnutým erasure flagem. Shared SIM/IZS přístup zůstává mimo mazání.
