import type { AggregatedFlightTrack, FlightTrackResponse } from "./types.js";

export function renderFlightTracksCot(response: FlightTrackResponse, options: { staleSeconds: number; generatedAt?: string }): string {
  const generatedAt = options.generatedAt ?? response.generatedAt;
  const events = response.tracks.map((track) => renderTrackEvent(track, generatedAt, options.staleSeconds)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><events source="csm-sim-flight-data" generated="${escapeXml(generatedAt)}">${events}</events>`;
}

function renderTrackEvent(track: AggregatedFlightTrack, generatedAt: string, staleSeconds: number): string {
  const time = normalizeTime(track.lastSeenAt) ?? generatedAt;
  const stale = new Date(Date.parse(time) + Math.max(30, staleSeconds) * 1000).toISOString();
  const uid = `SIM-FLIGHT-${safeUid(track.trackId)}`;
  const type = track.objectType === "UAV" ? "a-u-A-M-F-Q" : "a-u-A";
  const hae = typeof track.altitudeM === "number" ? round(track.altitudeM, 1) : 0;
  const ce = track.quality.measurement?.horizontalAccuracyM ?? track.quality.measurement?.rcM ?? 9999999;
  const le = track.quality.measurement?.verticalAccuracyM ?? 9999999;
  return [
    `<event version="2.0" uid="${escapeXml(uid)}" type="${type}" time="${escapeXml(time)}" start="${escapeXml(time)}" stale="${escapeXml(stale)}" how="m-g">`,
    `<point lat="${round(track.lat, 6)}" lon="${round(track.lon, 6)}" hae="${hae}" ce="${round(ce, 1)}" le="${round(le, 1)}"/>`,
    "<detail>",
    `<contact callsign="${escapeXml(track.presentation.label)}"/>`,
    track.headingDeg !== undefined || track.speedMps !== undefined
      ? `<track course="${round(track.headingDeg ?? 0, 1)}" speed="${round(track.speedMps ?? 0, 2)}"/>`
      : "",
    `<remarks>${escapeXml(remarksFor(track))}</remarks>`,
    "</detail>",
    "</event>"
  ].join("");
}

function remarksFor(track: AggregatedFlightTrack): string {
  const parts = [
    "CSM SIM normalized flight track",
    `trackId=${track.trackId}`,
    `objectType=${track.objectType}`,
    `predictionSupport=${track.quality.measurement?.predictionSupport ?? "unknown"}`,
    `confidence=${track.quality.confidence}`,
    `source=${track.deduplication.primarySourceId}`
  ];
  if (track.icao24) {
    parts.push(`icao24=${track.icao24}`);
  }
  if (track.metadata.remoteId) {
    parts.push(`remoteId=${track.metadata.remoteId}`);
  }
  return parts.join("; ");
}

function normalizeTime(value: string): string | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function safeUid(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 128);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
