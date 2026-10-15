# Bezpečná retence vydání a obrazů SIM

Stav 15.10.2026: inventura a pravidla připraveny; destruktivní retence SIM
**není aktivována**. Rozpracovaný přechod account-erasure a nedoložené dvě
kompletní kompatibilní návratové generace znamenají fail-closed stop mazání.
Nejde o tvrzení, že se již automaticky uvolňuje místo.

## Ověřený aktuální rozsah

Na `docker.home.cz` existuje 20 obrazů `sim-situation-data-api`, z nichž
jeden používá kontejner a 19 nemá kontejnerovou referenci. Jedenáct obrazů
má explicitní alias `rollback-*`, `before-*` nebo `pre-*`; to není odpad.
Kontrolovaly se reference **všech**, i zastavených kontejnerů, nejen SIM.
Aktuální SDA je `sha256:2f3aa1659d03c5eaf014353071e38f6abc1d2da1419a9ac2205a05b5873a5965`.
Root filesystem měl 95 %, zhruba 14 GiB volných; X5 zhruba 48 GiB volných.
Virtuální velikosti obrazů se nesčítají jako skutečně uvolnitelné místo.

Kanonické release adresáře `/srv/sim/releases`, `/home/voldzi/sim-releases`
a `/home/voldzi/sim-erasure-deploy` nejsou založené. Existují malé původní
`.deploy-*-backups` se skutečnými rollback metadata/Compose i soukromými
`.env` zálohami. Žádná z nich nebyla odstraněna ani čtena pro secrets.
Flat dirty `/srv/sim` není staré vydání určené k odstranění.

## Závazné podmínky budoucího apply

1. Omezit se na výslovně zaregistrované SIM image repositories; žádný globální
   prune, smazání volumes, kontejnerů, databází, secrets, záloh nebo jiných aplikací.
2. Vždy chránit image IDs všech kontejnerů, aktuální Compose a image overrides,
   ruční rollback/before/pre aliasy a všechny rozpracované build/deploy kandidáty.
3. Před automatickým mazáním doložit aktuální a **nejméně dvě ověřené návratové
   generace**: přesné image IDs, source revision, potřebné migrace/config artefakty,
   skutečný výsledek ověření a kompatibilitu s právě instalovaným schématem.
   Tag, existence obrazu nebo pořadí podle data samy tuto podmínku nesplňují.
4. U account-erasure DBv2 se nesmí za rollback považovat starý obraz bez startup
   replay nebo writer nekompatibilní s SQL003. Journal/fences se nevracejí zpět.
   Zdroj `ca1fd6b6046745e91cca6648e1e5bd3f93fc8422` i jeho budoucí obrazy jsou
   pending deployment hold až do společného vyhodnocení s COP.
5. Retence i všechny deployment vstupy musejí používat tentýž skutečný lock
   a ověřovanou historii start/end. U stávajícího legacy deploy postupu není
   tato integrace doložena; během nynějšího přechodu se nic nemaže.
6. Teprve po doložení bodů výše vytvořit dry-run plán, znovu ověřit kontejnerové
   reference, tag→ID, neměnnou historii/config a nepřítomnost deploymentu před
   každým odstraněním. Použít pouze konkrétní vlastní tagy bez `--force`,
   bez odvozeného/global prune. Nejasná vlastnická nebo rollback vazba = skip.
7. Konzervativní minimální stáří je 14 dní; stáří není důkaz nepotřebnosti.
   U release adresářů navíc prokázat nepoužívání bind mountem, current/rollback
   odkazem a migracemi. Stávající deployment-backups tím nejsou povoleny k mazání.
8. Audit zaznamená přesné odebrané tagy/IDs, aktuální chráněné generace a skutečné
   `df` před/po; nezměněné container IDs a health. Uvolněné místo vykázat jen
   jako skutečný rozdíl, ne součet sdílených Docker vrstev.

Do splnění předpokladů nepřidávat cron/systemd apply, který by chybějící
historii nahrazoval nejnovějšími třemi tagy. Nezvyšovat spotřebu interního
disku dalšími retenčními test buildy. Obnovitelný build cache/dočasné podklady
směrovat až při další schválené úpravě builderu pod ověřené
`/srv/x5-production/cache/csm-sim/`; Docker image store zůstává `/var/lib/docker`.
X5 UUID musí být `2f93f595-b61b-4eea-9054-7afa9b275b5b`, samostatný mount
s dostatkem místa; nepřítomný/jiný mount znamená konec bez změny.

## Výsledek tohoto ověření

Žádné mazání nebylo autorizováno automatickou domněnkou o 19 nepoužitých
obrazech. Uvolněno **0 B**, kontejnery a jejich funkční konfigurace beze změny.
Přesný čtecí audit je v
[záznamu 15.10.2026](../archive/2026-10-15_SIM_RETENTION_PREFLIGHT.json).
Zbývá skutečně zavést společný deploy lock/historii a doložit návratové
generace pro novou schema epochu; do té doby je tato větev dokumentační
plán s explicitně zastaveným mazáním, nikoli nasazená retenční služba.
