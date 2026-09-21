export interface RoadMatchCandidate {
  directedEdgeId: string;
  headingDeg: number;
  distanceM: number;
  lat: number;
  lon: number;
}

export interface RoadMatchEvidence {
  contractVersion: "sim-road-match-v1";
  state: "matched" | "ambiguous" | "unavailable";
  matchedAt: string;
  routingDataset?: string;
  candidate?: RoadMatchCandidate;
  reason: string;
}

/** An observation never becomes a closure; nearby parallel roads remain ambiguous. */
export function selectDirectedRoadMatch(
  candidates: RoadMatchCandidate[],
  headingDeg: number | undefined,
  dataset: string | undefined,
  matchedAt: string
): RoadMatchEvidence {
  const base = { contractVersion: "sim-road-match-v1" as const, matchedAt, ...(dataset ? { routingDataset: dataset } : {}) };
  if (!dataset) return { ...base, state: "unavailable", reason: "routing_dataset_unverified" };
  if (headingDeg === undefined) return { ...base, state: "ambiguous", reason: "travel_direction_unknown" };
  const headingDifference = (heading: number) => Math.abs(((heading - headingDeg + 540) % 360) - 180);
  const unique = new Map<string, RoadMatchCandidate>();
  for (const candidate of candidates) {
    if (
      !/^[0-9]+$/.test(candidate.directedEdgeId) ||
      !Number.isFinite(candidate.distanceM) ||
      candidate.distanceM < 0 ||
      candidate.distanceM > 50 ||
      !Number.isFinite(candidate.headingDeg) ||
      candidate.headingDeg < 0 ||
      candidate.headingDeg >= 360 ||
      headingDifference(candidate.headingDeg) > 45 ||
      !Number.isFinite(candidate.lat) ||
      Math.abs(candidate.lat) > 90 ||
      !Number.isFinite(candidate.lon) ||
      Math.abs(candidate.lon) > 180
    )
      continue;
    const prior = unique.get(candidate.directedEdgeId);
    if (!prior || candidate.distanceM < prior.distanceM) unique.set(candidate.directedEdgeId, candidate);
  }
  const ranked = [...unique.values()].sort((a, b) => a.distanceM - b.distanceM);
  const first = ranked[0];
  if (!first) return { ...base, state: "unavailable", reason: "no_compatible_directed_edge" };
  if (ranked[1] && ranked[1].distanceM - first.distanceM < 10) return { ...base, state: "ambiguous", reason: "nearby_parallel_or_crossing_edges" };
  return { ...base, state: "matched", candidate: first, reason: "unique_directional_candidate" };
}
