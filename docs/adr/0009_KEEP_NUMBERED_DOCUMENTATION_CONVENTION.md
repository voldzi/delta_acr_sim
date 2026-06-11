# ADR 0009: Keep Numbered Documentation Convention

## Status

Accepted

## Context

CSM SIM is an existing monorepo with a mature numbered documentation structure:
architecture, application, integration, security, runbooks, testing, provider
contracts, and ADRs are already split into indexed folders under `docs/`.

The central application standards define a flat mandatory document set. They
also allow established existing documentation conventions when each mandatory
topic is mapped, the exception is recorded in an ADR, and CI enforces the
mapped set.

## Decision

Keep the numbered documentation convention.

`docs/README.md` is the active mapping from central standard topics to local
canonical documents. `scripts/validate-skeleton.sh` validates the mapped set
instead of requiring duplicate flat files such as `docs/api.md` and
`docs/runbook.md`.

## Consequences

The repository avoids duplicate documentation and preserves existing links.

New documentation must be added to the mapped structure, and `docs/README.md`
must be updated when ownership of a standard topic changes.

If the repository later adopts the flat standard set, this ADR must be
superseded and the validator changed accordingly.
