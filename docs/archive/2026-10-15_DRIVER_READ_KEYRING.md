# Driver reader — bezpečnostní revize keyringu 15. 10. 2026

**16/16 skupin prošlo** v novém izolovaném Linux/arm64 testu od
`07:42:58.739Z` do `07:43:12.146Z`, Node 24.20.0, PostgreSQL 18.6.
[Receipt](2026-10-15_DRIVER_READ_KEYRING.json) má SHA-256
`e2746c3f2fcb1e39dd248ef643d573fabc802c7db22bb3ad494f72a3927ca29c`.

Po odstranění dvou nadbytečných EOF prázdných řádků pouze v testovacích
souborech proběhlo nové ověření finálních bajtů, opět **16/16**, od
`07:48:52.103Z` do `07:49:05.784Z`. [Finální receipt](2026-10-15_DRIVER_READ_KEYRING_FINAL.json)
má SHA-256 `04231a1fdbad9d5ea29d49d6c3470b7178551e277f64883b560cc45824035ce5`.
Předchozí receipt zůstal beze změny a byl připnut i v novém běhu; nejde o
dalších šestnáct případů. Reader a SQL se v tomto kroku nezměnily.

Nová revize `root-read-admission.mjs` má SHA-256
`259d53669e7f90d940a9c3c9eb8fffd964a3e2b6a364169af480631ba22fde56`.
Při vydání admission používá původní ověřený keyring snapshot. Signer
musí patřit právě do něj; před a po podpisu se kontroluje shoda aktuálních
keyring/signer bytes. Při změně se nevydá nový podpis nad starými důkazy.

Nový runner `scripts/test-driver-read-keyring.mts` a fixture
`scripts/fixtures/driver-read-keyring/harness.mjs` jsou samostatné.
Znovu ověřily patnáct původních skupin nad novým readerem a jednu novou
skupinu se správným signerem, signerem mimo trust set a vyměněným
keyringem. Starý patnáctipřípadový runner, fixture, Dockerfile, JSON i
popis byly před a po testu připnuté a zůstaly beze změny. Jejich dřívější
výsledek se tímto nepřeznačuje ani nepřičítá.

Skutečné Root custody, Ed25519, přísné lokální TLS, SQL004 a timeouty byly
ověřeny bez databázových či kladných verifier náhrad. Peer a registry
zůstávají výslovně syntetické; deklarovaná source revision v registraci
není loaded-source attestation. Keyring negative není deterministický
race test rotace uvnitř `issue()`. Produkční Root config/generation lease,
nativní enrollment, skutečná obnova a nasazení zůstávají samostatné gates.

Žádná produkční změna, provider volání nebo smazání skutečného účtu.
Oba nové vlastní kontejnery, jejich svazky a kontext byly odstraněny;
kontrola přesného labelu byla prázdná. Bez vnější sítě, host bind mountů,
veřejných portů, image pull/build nebo globálního prune.
