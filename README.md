# COP Air & Situation Simulator

Samostatný pilotní skeleton SIM systému pro generování výhradně syntetických dat, řízení scénářů, dry-run/mock publisher workflow a AI Scenario Assistant draft workflow.

## Lokální spuštění

```bash
pnpm install
pnpm dev
```

- API: `http://localhost:4000`
- Web: `http://localhost:5173`
- Health: `http://localhost:4000/health/live`

## Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
```

Výchozí port web/API gateway je `5020`:

```text
http://localhost:5020
```

## Bezpečnostní hranice

- Všechna generovaná data jsou syntetická.
- Publisher odmítá event bez `SYNTHETIC` handling caveat a `simulation.synthetic: true`.
- AI vrstva vytváří pouze draft, nikdy přímo nespouští scénář.
- Targeting, navádění, zbraňové workflow a taktické bojové doporučení jsou mimo rozsah.

## Ověření

```bash
pnpm typecheck
pnpm test
pnpm build
```
