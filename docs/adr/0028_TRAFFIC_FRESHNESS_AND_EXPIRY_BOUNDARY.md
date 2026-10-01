# ADR 0028 Traffic freshness and expiry boundary

Status: implemented and locally tested; live deployment and acceptance pending.
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

`SITUATION_DATA_TPEG2_ALIGN_TO_LAST_MODIFIED=false` remains opt-in. The
October 1 acceptance trace found successive Last-Modified generations
303–304 seconds apart; 300-second starts subsequently returned a 304 and
expired generations. The revised policy re-anchors on each distinct valid
header, adds a 15-second publication margin and, after two consecutive
unskipped observations, uses the median of up to five intervals in
`[configured minimum, configured minimum + 60 seconds]`. It never requests
earlier than the monotonic/configured floor. Skipped/implausible intervals
reset the estimate; missing, invalid, future or more-than-two-period-old
headers use start-based cadence. Regressing headers reset the estimate and
cannot drive that request's next slot. A 304 may reuse the prior header but
never renews a measurement, content age or expiry. This is a bounded timing
hint, not proof of publication semantics or a guarantee of fresh content.
Activation and three-generation observation are recorded separately from
synthetic tests. Rollback sets only the opt-in flag to false and recreates
only situation-data-api; quota persistence and expiry protections remain.
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
An updater preparing a previous release refuses to write after the current
release symlink changes. Weekly activation drops obsolete pending reports.

## SIM report and route cache contract

The existing authenticated report and status operations add optional
`overlayGeneration` and `usableUntil`. The updater commits the deadline,
generation and pending report before trying to deliver the report. A clearing
operation has a new generation, zero applied counts, degraded status and
`usableUntil=updatedAt`. Pending reports carry no credentials and live in
memory-backed `/run/valhalla-traffic`.

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

Live acceptance must observe at least three active TFP cycles, inspect the
actual HTTP start and content-change times, verify a fresh apply and expiry
clear, verify idle behavior and ordinary road routing, and confirm X5 mount
and updater hashes. This is freshness acceptance, not measured ETA accuracy.
Native OpenLR activation still requires ADR 0027's graph and geographic gates.

## Deployment and rollback

Deploy the additive SIM contract first by rebuilding only situation-data-api.
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
