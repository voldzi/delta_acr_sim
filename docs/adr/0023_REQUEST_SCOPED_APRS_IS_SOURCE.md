# ADR 0023: Request-scoped APRS-IS map source

## Status

Accepted; runtime remains opt-in until a receive-only identity is configured.

## Decision

The aprs.fi API is unsuitable for an area map layer. Its documented API
queries exact callsigns, not arbitrary map extents; its terms prohibit
preloading and archival use and require visible attribution, a unique
User-Agent, and a free public application. The aprs.fi website and internal
web APIs must not be scraped.

SIM therefore receives APRS-IS directly on filtered port 14580. An APRS-IS
connection starts only after a COP server-side request for the optional APRS
layer. The login uses a receive-only passcode (`-1`) and the requested area
filter. The connection is bounded by time, area and station count. Results are
normalized in memory and expire after 30 seconds. No raw packet or position
history is persisted.

The initial decoder accepts ordinary uncompressed APRS position packets.
Other position formats are explicitly ignored until a tested decoder is
available. Station type is derived only from known position symbols and
course/speed data, never from SSID. The full callsign, including SSID, is the
stable identity. Unknown type and missing position remain explicit states.
Packet UTC timestamp is used when present; otherwise the SIM receipt time is
labelled as such, rather than misrepresented as transmitter report time.

Provider failure is isolated to this source and does not change overall SIM
readiness, unrelated layers or routing. Previous results may be returned only
as stale, during bounded exponential backoff. COP displays an APRS-IS
attribution link and must not treat the points as verified incidents or road
navigation data.

## Activation and rollback

Set `APRS_IS_CALLSIGN` to an operator-approved receive-only identity and add
`aprs_is` to `SITUATION_DATA_ENABLED_SOURCES`. Without both, the layer is
disabled. Rollback removes `aprs_is` from that list and restarts only
`situation-data-api`. No database migration or historical data removal is
needed.

## Sources

- https://aprs.fi/page/api
- https://aprs.fi/page/tos
- https://www.aprs-is.net/javAPRSFilter.aspx
- https://www.aprs-is.net/connecting.aspx
