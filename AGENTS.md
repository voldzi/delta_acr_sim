# CSM SIM Agent Guide

## Mission

This repository contains CSM SIM: a server-side data provider and synthetic
scenario simulator for the Civil Situation Map ecosystem. SIM exposes multiple
REST API surfaces, a local operator web UI, and cached provider integrations for
map layers consumed by COP server-side adapters.

## Working Style

- Prefer retrieval-first workflow before broad repository scanning.
- Use Chroma MCP tools when available:
  - `search_code` for implementation lookup
  - `search_docs` for documentation lookup
  - `search_all` when the location is unclear
  - `get_file_context` after selecting a relevant hit
- If MCP tools are not exposed, use the CLI fallback:
  - `"/Users/voldzi/Documents/Development/18 2026/chromadb/tools/chroma-dev.sh" search-all "<query>" --root . --repo-name csm-sim --limit 5`
- If retrieval is unavailable or insufficient, fall back to direct repository
  inspection and state that retrieval was unavailable.
- After meaningful repository changes, reindex with `chroma-dev reindex --root .`
  when the tool is available.

## Source of Truth

- `README.md` for project purpose and local entry points.
- `docs/README.md` for the mapped documentation set.
- `openapi/openapi.json` for the binding REST API contract.
- `docs/provider/02_MAP_CATALOG_PROVIDER_CONTRACT.md` for the provider catalog
  model used by COP.
- `docs/integration/` for integration contracts.
- `apps/*/src/` and `packages/*/src/` for implementation.
- `CLAUDE.md` and `AGENTS.md` must stay aligned except for the Compact
  Instructions section in `CLAUDE.md`.

## Environment

- Runtime: Node.js 24 in Docker, pnpm 10.33.0.
- Package manager: `pnpm`.
- Main services:
  - `apps/simulator-api`
  - `apps/simulator-web`
  - `apps/flight-data-api`
  - `apps/situation-data-api`
  - `apps/safety-data-api`
  - `apps/tak-gateway-api`

Commands:

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm openapi:build
pnpm openapi:validate
pnpm openapi:lint
bash scripts/validate-skeleton.sh
docker compose up -d --build
```

Production pilot host:

```text
docker.home.cz
```

## Permissions

- `git push` is allowed when the change has been intentionally prepared and the
  task requires publishing or syncing the branch.
- `ssh docker.home.cz` is allowed when the task requires access to the pilot
  deployment host.
- Do not manipulate VPN, VLAN, firewall, or network segmentation.
- If sudo is needed, provide the command for the user to run.

## Application Skeleton Standards

This repository follows the central application standards maintained in the
chromadb tooling repository under `docs/standards/`.

SIM keeps its established numbered documentation convention under `docs/`.
The mandatory standard topics are mapped in `docs/README.md`, and the exception
is recorded in `docs/adr/0009_KEEP_NUMBERED_DOCUMENTATION_CONVENTION.md`.
Do not add duplicate flat documents unless that ADR is superseded.

Binding summary:

- The mandatory documentation topics must stay covered by the mapping in
  `docs/README.md`.
- `openapi/openapi.json` is the binding API contract. Do not change an endpoint
  without updating it.
- Historical YAML OpenAPI snapshots live in `docs/archive/openapi-yaml/`.
- Current API error responses use `correlationId`; the central `requestId`
  unification is a documented compatibility-safe follow-up, not an implicit
  breaking change.
- Logging and request handling must preserve correlation IDs.
- Health and readiness endpoints must remain documented; existing live endpoints
  must not be renamed.
- Never commit secrets. `.env.example` uses placeholders or dev-only examples.
- `scripts/validate-skeleton.sh` must pass; CI runs it.

## Documentation Rules

- Current-state documentation stays in the mapped active documents.
- Historical audits, generated exports, and superseded designs go to
  `docs/archive/`.
- Update `docs/README.md` when the active documentation set changes.
- Add or update an ADR when a decision changes architecture, data model,
  storage, security boundaries, integrations, deployment, rollback, or a prior
  decision.
- If a change affects API, configuration, deployment, testing, security, data
  handling, or operations, update the corresponding mapped document in the same
  change.

## Validation

Minimum verification for repository-wide changes:

```bash
bash scripts/validate-skeleton.sh
pnpm typecheck
pnpm test
pnpm build
pnpm openapi:validate
```

For API-only changes, include the affected service test and `pnpm
openapi:validate`.

If Chroma is available after meaningful changes:

```bash
chroma-dev reindex --root . --repo-name csm-sim
chroma-dev search-all "CSM SIM documentation" --root . --repo-name csm-sim --limit 5
```

If a check cannot be run, state that explicitly.

## Change Discipline

- Do not silently change config semantics.
- Update docs when behavior changes.
- Keep provider endpoints server-to-server; COP is the public presentation and
  decision layer.
- Do not expose real partner data, secrets, raw TAK data, or internal metrics to
  public clients.
- Do not introduce targeting, weapon workflow, guidance, or tactical combat
  recommendations.
