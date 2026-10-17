# ADR 0046: Root-private shared release preparation

Status: source candidate; production preparation/execution not accepted.

## Decision

Use one interactive Root process on docker for preparation and an explicitly
confirmed disabled reset. Existing COMM public-key and storage TTY-password custody must be verified
before asking for a PostgreSQL password. No new key, forwarding, public port,
network rule or stored administrator password is introduced.

Re-export pinned immutable dependency2e and actual COP286 compiled app into the
new fixed Root-owned readonly root
`/srv/x5-production/staging/cop/clean-operator-shared-v3`. Public source archives
are SHA-verified before code execution; preserve exact candidate dist when
overlaying reviewed operator sources. Do not adopt/delete the old UID1000 root.
COP and SIM exact root pins must be changed together.

The Root-only existing-secret collector reads only reviewed Messaging keys over
the held private COMM pipe, checks exact container IDs/images before/after and
matches runtime and administrator database backend identities. It performs real
read-only inspection, never schema mutation. Passwords, owner keys, tokens and
the complete private configuration remain only in server process memory/pipes.

Prepare twelve distinct actual plans, review their public digests, then publish
only the new protected public PLAN and COP enrollment manifest. Existing plans
are not silently overwritten. The destructive reset requires a second explicit
confirmation and the existing held-admission executor with drift revalidation.
Messaging schema installation and its nonce-bound empty initial baseline are
separate from the preceding reset and run under that same admission.

## Gates and limits

The exact whole-provider acceptance gate remains mandatory before a PG prompt
and again before freeze. A completed-operation Router outage cannot be labeled
as an outage during pending deletion. Provider regressions prevent GO.

Disabled restart, fresh runtime capabilities, joint canary and activation remain
separate owner-coordinated steps. The current CLI explicitly stops after disabled
reset and reports pending restart; it does not claim activation. Source/mock
tests and isolated SQL acceptance do not substitute for real Root custody,
actual twelve-plan production inspection or runtime acceptance.

## Failure and recovery

On failure keep private values out of logs/files, close connections/transports,
leave disabled state and retained fences/journals intact. Do not restart writers
automatically after partial reset or invent positive provider receipts. Failed
Root-owned public staging is retained for review. No real account is deleted for
acceptance testing.

## Explicit final activation and staging custody

The later explicit `--complete-release` mode adds the concrete guarded activation
chain documented in integration24; preparation-only and disabled-reset modes
retain their earlier boundaries. No execution is inferred from source tests.

The human separately approved changing only the directory
`/srv/x5-production/staging/cop` from UID/GID1000 mode0700 to Root:Root0755,
nonrecursively. This permits local listing of staging names; child permissions
and contents remain unchanged. Bootstrap performs this only after transport and
public archive verification, with exact X5 UUID/device, canonical no-symlink
path, held O_DIRECTORY/O_NOFOLLOW fd, absent trusted target and unchanged child
inventory/CAS. It uses fchown/fchmod on that single fd, never a recursive path
operation. Unknown custody, symlink, occupied target or drift refuses. Actual
Root execution remains operator-supervised and the temporary key lifetime ends
in the outer finally.
