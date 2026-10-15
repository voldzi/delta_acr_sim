# Ověření chráněného Linux readeru měření

15. 10. 2026 v 07:08:02–07:08:13 UTC prošlo **15 samostatných integračních
případů** skutečného readeru. Použity byly Linux arm64, Node 24.20.0,
PostgreSQL 18.6, skutečné Root file-custody kontroly, Ed25519 podpisy,
TLS s ověřenou CA/hostname a skutečná SQL004. Žádný pg stub ani callback
vracející kladné oprávnění nebyl použit.

[Strojový záznam](2026-10-15_DRIVER_READ_ROOT.json) připíná všechny zdroje,
obrazy a závislosti. Root reader má SHA-256
`cbd1b4c4fa6d8c75ff06a9f5ea9aef0948477a530e73bc7e8c85cfe464197192`;
SQL004 zůstala `791545b9…`. Zdroj i přesný runner byly před/po stejné.
Testy 14 PG18.3, 7 čistých Node případů a historické testy jsou oddělené.

Ověřeny jsou všechny read purposes, korelace požadavku, skutečné podpisy
a expirace, symlink/mode custody, změna schématu, účinných práv,
checkpointu, registrace, nezávislé kotvy a živé registry. Podepsaná, ale
nesprávná inventura nestačí. Skutečný TCP blackhole až po TLS/SCRAM
startup ověřil klientský timeout a úklid; ověřovač nevydal admission.
Reader v žádném případě nezměnil cílové ani registry řádky.

Dva první běhy skončily před testy na správné kontrole Root vlastnictví:
kopírování do kontejneru zachovalo hostitelské UID. Oprava stanovila
Root custody pouze v syntetickém balení; bezpečnostní kontroly readeru
se nezměnily. Neúspěšné běhy nemají PASS receipt. Finální běh nepoužil
build/pull, vnější síť, host mount ani veřejný port. Oba jeho kontejnery,
jejich případné implicitní svazky a dočasný kontext byly odstraněny.

Identita peer je výslovně syntetická a nepředstavuje kernelovou native
akceptaci. Podepsané fixtures ani jejich metadata nejsou produkční
owner evidence, enrollment, přijatý restore nebo aktivace mazání.
Společný COP broker/publisher a skutečný provozní binding se přijímají
zvlášť podle runbooku 19.
