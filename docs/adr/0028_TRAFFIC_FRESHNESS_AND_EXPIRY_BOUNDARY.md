# ADR 0028 Traffic freshness and expiry boundary

Status: initial SIM and Valhalla reliability release deployed and smoke-tested; final updater hardening and joint live acceptance pending.
Date: 2026-10-01
Owner: SIM and Valhalla application maintenance.

## Decision and scope

Traffic freshness is a deadline, not a cache age or a successful HTTP check.
SIM schedules TPEG2 traffic flow refreshes independently of traffic events and
the Valhalla poll. Valhalla removes expired current speeds independently of
provider requests. SIM must not return cached live-derived travel times after
their source deadline. This decision does not change the accepted graph map,
provider credentials, network or public endpoints.

The October 1 inspection found growing observation-to-apply delays, a dynamic
snapshot with only 0.249 seconds of remaining validity when received, and
coupled TFP and TEC updates. These measurements establish freshness problems,
not the accuracy of an estimated arrival time. Static mapping coverage of
35,639 out of 55,150 references is not an ETA accuracy percentage.

## Provider request scheduling

Each TFP, TEC and static feed has separate content, revision, error, conditional
request validators and eligibility. A successful TFP response commits its
value and revision atomically even if TEC fails. HTTP 304 advances only the
check time, not the content age, measurement time or expiry.

During a sliding road-activity lease, the TFP scheduler measures its next slot
from HTTP start rather than completion. It coalesces concurrent refreshes,
skips missed slots and enforces at least the configured 300-second minimum
using a monotonic clock. Cold failures also reserve a slot and apply bounded
backoff and Retry-After. Walking and cycling do not create the lease.

A mode-0600 timing-only quota file under the configured SIM traffic cache
preserves the request floor across process restart. It contains no payload,
token or URL. Failure to write it prevents provider requests. Static content
normally has a 24-hour in-memory TTL; a restart without restored static content
may reload it after the 300-second quota floor rather than waiting a day.

`SITUATION_DATA_TPEG2_ALIGN_TO_LAST_MODIFIED=false` is an opt-in experiment.
It may align TFP starts to a validated HTTP Last-Modified phase plus a
10-second margin, without violating the request floor. It remains disabled
until observation confirms the header's publication meaning and cadence.
Measurement timestamps must never be substituted for publication time.

## Flow validity and local expiration

An applicable speed needs a finite positive value and an explicit timezone
in its measurement timestamp. Missing, malformed or timezone-free observation
times, observations over 30 seconds in the future, malformed supplied expiry,
expiry before observation and expired records are rejected. A missing expiry
is bounded by observation plus maximum age. If expiry is supplied, the earlier
of expiry and the maximum-age deadline wins. Zero is unavailable, not proof
of a road closure.

The overlay's deadline is the earliest deadline among applicable mapped flows.
At that deadline, the guard conservatively clears the whole live overlay.
This can discard some still-valid speeds but cannot extend an expired one.
`valhalla-traffic-expiry.service` checks locally each second and does not
download provider data. Its bounded report retry is outside the archive lock.
The one-minute updater uses fixed calendar slots rather than completion-based
rescheduling. An upstream timeout cannot postpone local expiry checking.

Archive writes, expiry clearing and weekly skeleton replacement share one
host-local lock. Network calls do not hold it. Applied-edge ledgers and report
state are atomically replaced. Missing or corrupt ledgers cause every traffic
record to be cleared in place, preserving the inode mapped by Valhalla.
An empty update also clears all traffic records, even with a valid empty
ledger. Clearing uses 64 KiB blocks rather than one write per edge. Neither
the old ledger nor the completed-clear proof is replaced before all writes
finish. A generation is marked in progress before any archive mutation;
interruption cannot retain a trusted deadline from the preceding generation.

Reuse requires matching dataset, static/dynamic revisions and matcher, a
validated generation, agreeing ISO and epoch deadlines, and a deadline
bounded by the host age policy. Legacy deadlines alone are untrusted. A
degraded zero generation may be reused only with an exact empty ledger and
no still-usable positive speed anywhere in the same feed. Expiration of its
earliest flow does not authorize skipping still-valid peers.

When dataset identities are absent, the guard cannot fabricate a SIM report.
It records only a local completed-clear proof tied to the exact archive path,
device, inode, size and nanosecond modification time. Changed archive identity,
a nonempty or invalid ledger, an in-progress write or forced clearing rejects
that proof. This prevents repetitive full zeroing while preserving recovery.

An updater preparing a previous release refuses to write after the current
release symlink changes. Weekly activation drops obsolete pending reports.

## SIM report and route cache contract

The existing authenticated report and status operations add optional
`overlayGeneration` and `usableUntil`. The updater commits the deadline,
generation and pending report before trying to deliver the report. A clearing
operation has a new generation, zero applied counts, degraded status and
`usableUntil=updatedAt`. Pending reports carry no credentials and live in
memory-backed `/run/valhalla-traffic`.

Before writing a positive generation, the updater persists a new degraded
zero-generation report and requests its acceptance outside the archive lock.
HTTP 204 alone is only transport acknowledgement: SIM can ignore an older
report while returning 204. The updater must also read the existing internal
status and confirm the exact dataset, revisions, generation, timestamps and
zero applied counts. Failure, a competing clear or a mismatch prevents all
positive writes. After confirmation it reacquires the archive lock, checks
the release and unchanged runtime state, and recomputes flow validity. A
generation that expired during acknowledgement is cleared rather than applied.
The final report timestamp must be strictly later than its confirmed zero
generation because SIM ignores equal update times. A one-microsecond ordering
floor handles frozen/slightly reversed clocks within the existing 30-second
tolerance. Greater clock drift clears speeds and fails closed; the floor
never replaces a source observation or extends its validity deadline.

SIM accepts older report shapes for compatibility but never marks them current
without a valid generation and unexpired bounded deadline. Reports are ordered
by microsecond update time; an older report cannot overwrite a newer clear.
Repeated or out-of-order acknowledgement does not extend validity.

Road-route cache keys include generation, state and deadline. Both normal TTL
and stale-on-error are bounded by that absolute deadline. A calculation that
crosses the deadline or changes generation returns a specific 503 rather than
a direct-line or stale ETA fallback. When no acknowledged current overlay is
usable, Valhalla auto and truck costing explicitly excludes current speed and
uses the ordinary freeflow, constrained and predicted speed sources.

## Acceptance and limits

Synthetic regression checks cover slow downloads without drift, concurrent
requests, restart quota, cold 503 and Retry-After, independent TEC failure,
304, timestamps, expiry clearing during report outage, corrupted ledgers,
out-of-order reports, route cache expiry and routing error boundaries.
They also cover acknowledged invalidation before positive writes, ignored
204 reports, provider/control outages, concurrent expiry without a network
call under the archive lock, interruption with a preceding current generation,
empty-ledger recovery, mixed-expiry reuse and bounded block-write clearing.

Live acceptance must observe at least three active TFP cycles, inspect the
actual HTTP start and content-change times, verify a fresh apply and expiry
clear, verify idle behavior and ordinary road routing, and confirm X5 mount
and updater hashes. This is freshness acceptance, not measured ETA accuracy.
Native OpenLR activation still requires ADR 0029's graph and geographic gates.

## Deployment and rollback

Deploy the additive SIM contract first by rebuilding only situation-data-api.
At the first transition from a version without persisted request timing, stop
only that service and run `seed-provider-request-timing.mjs` through the new
Compose image with the existing cache mount. It atomically reserves at least
300 seconds for all feeds, preserving any longer existing backoff. Verify the
X5 UUID and stopped old process before seeding. The new service can start
immediately but may warm up for five minutes; do not bypass that request floor.
Then use `scripts/install-valhalla-traffic-reliability.sh --install` to patch
the updater, weekly archive-reset locking, expiry unit and timer. It backs up
the previous maintenance files and does not recreate the Valhalla container.
Root installation requires the operator's existing sudo authentication.

On installation failure, restore the backed-up files and previous timer state.
For a later rollback, stop only traffic units, clear current speeds, restore
the previous maintenance files and reload systemd. Do not change the routing
release, Docker daemon or provider token. A partial rollback must not remove
SIM's deadline protection while an older updater can retain expired speeds.
See the Valhalla runbook for the ordered procedure and evidence requirements.
