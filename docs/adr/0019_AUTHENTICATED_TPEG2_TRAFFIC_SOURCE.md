# ADR 0019: Authenticated TPEG2 Traffic Source

## Status

Accepted

## Context

SIM needs road-flow information closer to real time than the existing SRTI LOD
event projection. NDIC provides authenticated TPEG2 TFP static/dynamic and TEC
full snapshots. The dynamic TFP source is refreshed every five minutes. The
provider terms permit value-added processing but restrict redistribution of raw
or unprocessed data.

## Decision

SIM owns the TPEG2 client and keeps `TPEG2_API_TOKEN` only in the production
server environment. COP and browsers continue to call SIM and never call the
provider directly.

The adapter streams the XML so the large static snapshot is not buffered as one
string. It joins dynamic TFP records to static OpenLR reference lines by message
ID, and maps TEC records to normalized traffic event features. The projection
publishes speed, delay, validity, quality and provider codes, but never raw XML.
Setting `includeRaw=true` does not override this restriction.

SIM sends conditional `If-None-Match` and `If-Modified-Since` requests, accepts
`304 Not Modified`, coalesces concurrent refreshes and keeps the last valid
in-memory snapshot if a later refresh fails. Dynamic TFP and TEC refresh no more
often than every 300 seconds; the static location snapshot refreshes once per
day. A service restart can temporarily require downloading the static snapshot
again; this is acceptable because the provider remains the authoritative copy.

## Consequences

COP receives current, normalized traffic-flow and event layers without gaining
access to credentials or restricted payloads. The source is operationally
dependent on the provider and token, but stale-on-error behavior limits brief
outages. OpenLR reference lines are explicitly marked as reference geometry;
exact road-shape map matching remains a future enhancement.
