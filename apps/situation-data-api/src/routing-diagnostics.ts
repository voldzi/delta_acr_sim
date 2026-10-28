/** Internal, expiring, error-only diagnostics. Never a routing or access proof. */
export interface RoutingRequestContext {
  correlationId: string;
}
export type RoutingDiagnosticStage =
  | "known_closure_preflight"
  | "native_request"
  | "native_warning_validation"
  | "geometry_closure_validation"
  | "waypoint_snap_validation"
  | "route_final_validation";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function routingRequestContext(value: unknown): RoutingRequestContext | undefined {
  return typeof value === "string" && value.length === 36 && UUID.test(value) ? { correlationId: value } : undefined;
}
const CODES = new Set([
  "ROUTING_RESTRICTIONS_RELAXATION_REQUIRED",
  "ROUTING_LOCATION_NOT_ROUTABLE",
  "ROUTING_TARGET_NOT_ROUTABLE",
  "ROUTING_WAYPOINT_NOT_ROUTABLE",
  "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED",
  "ROUTING_KNOWN_CLOSURES_UNAVAILABLE",
  "ROUTING_KNOWN_CLOSURES_UNSUPPORTED",
  "ROUTING_KNOWN_CLOSURES_CHANGED",
  "ROUTING_GRAPH_STALE",
  "ROUTING_PROFILE_UNAVAILABLE",
  "ROUTING_ARRIVAL_UNSUPPORTED",
  "ROUTING_BUSY",
  "ROUTING_TRAFFIC_EXPIRED"
]);
const STAGES = new Set<RoutingDiagnosticStage>([
  "known_closure_preflight",
  "native_request",
  "native_warning_validation",
  "geometry_closure_validation",
  "waypoint_snap_validation",
  "route_final_validation"
]);
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
export interface NativeRoutingDiagnosticFacts {
  costing: "auto" | "truck" | "other";
  requestedDateTimeMode: "none" | "depart_now" | "depart_at" | "unknown";
  requestedVariantCount: number | null;
  returnedVariantCount: number;
  returnedVariantCountTruncated: boolean;
  nativeWarningCodes: number[];
  warningCounts: { root: number; primary: number; alternate: number; malformed: number };
  nativeWarningsTruncated: boolean;
}
export function nativeRoutingDiagnosticFacts(
  payload: { costing?: unknown; date_time?: unknown; alternates?: unknown },
  body: unknown
): NativeRoutingDiagnosticFacts {
  const response = record(body),
    trip = record(response?.trip),
    alternates = response?.alternates;
  const alternateList = Array.isArray(alternates) ? alternates : [];
  const counts = { root: 0, primary: 0, alternate: 0, malformed: 0 },
    codes = new Set<number>();
  let truncated = alternateList.length > 16;
  const addCount = (scope: keyof typeof counts, amount: number) => {
    truncated ||= counts[scope] + amount > 64;
    counts[scope] = Math.min(64, counts[scope] + amount);
  };
  const warnings = (value: unknown, scope: "root" | "primary" | "alternate") => {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      addCount("malformed", 1);
      return;
    }
    addCount(scope, value.length);
    truncated ||= value.length > 64;
    for (const w of value.slice(0, 64)) {
      const code = record(w)?.code;
      if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 9999) {
        if (codes.size < 16) codes.add(code);
        else if (!codes.has(code)) truncated = true;
      } else addCount("malformed", 1);
    }
  };
  warnings(response?.warnings, "root");
  warnings(trip?.warnings, "primary");
  for (const a of alternateList.slice(0, 16)) warnings(record(record(a)?.trip)?.warnings, "alternate");
  const dateTime = record(payload.date_time),
    variants = (trip ? 1 : 0) + alternateList.length;
  return {
    costing: payload.costing === "auto" || payload.costing === "truck" ? payload.costing : "other",
    requestedDateTimeMode: payload.date_time === undefined ? "none" : dateTime?.type === 0 ? "depart_now" : dateTime?.type === 1 ? "depart_at" : "unknown",
    requestedVariantCount:
      typeof payload.alternates === "number" && Number.isInteger(payload.alternates) && payload.alternates >= 0 && payload.alternates <= 2
        ? payload.alternates + 1
        : null,
    returnedVariantCount: Math.min(3, variants),
    returnedVariantCountTruncated: variants > 3,
    nativeWarningCodes: [...codes].sort((a, b) => a - b),
    warningCounts: counts,
    nativeWarningsTruncated: truncated
  };
}
// No request, coordinates, vehicle values, identifiers or provider text retained.
const nativeFacts = new WeakMap<object, NativeRoutingDiagnosticFacts>();
export const rememberNativeRoutingFacts = (target: unknown, payload: { costing?: unknown; date_time?: unknown; alternates?: unknown }, body: unknown): void => {
  try {
    if (target !== null && typeof target === "object") nativeFacts.set(target, nativeRoutingDiagnosticFacts(payload, body));
  } catch { /* A diagnostic formatter/storage fault cannot affect routing. */ }
};
export const recalledNativeRoutingFacts = (body: unknown): NativeRoutingDiagnosticFacts | undefined =>
  body !== null && typeof body === "object" ? nativeFacts.get(body) : undefined;

export class BoundedRoutingDiagnostics {
  private remaining = 16;
  private closed = false;
  private readonly until: number;
  private readonly monotonicDeadline: number;
  constructor(
    until: string | undefined,
    private readonly emit: (line: string) => void = (line) => console.info(line),
    private readonly wallNow = () => Date.now(),
    private readonly monotonicNow = () => performance.now()
  ) {
    const parsed = typeof until === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(until) ? Date.parse(until) : NaN;
    const duration = parsed - wallNow();
    this.until = Number.isFinite(parsed) && duration > 0 && duration <= 600_000 ? parsed : 0;
    this.monotonicDeadline = monotonicNow() + (this.until ? duration : 0);
  }
  rejected(
    context: RoutingRequestContext | undefined,
    stage: RoutingDiagnosticStage,
    code: string,
    facts: NativeRoutingDiagnosticFacts | undefined,
    closureGeometryValidated: boolean
  ): void {
    try {
      const safe = routingRequestContext(context?.correlationId);
      if (!this.until || this.closed || this.remaining <= 0) return;
      if (this.wallNow() >= this.until || this.monotonicNow() >= this.monotonicDeadline) {
        this.closed = true;
        return;
      }
      if (!safe || !STAGES.has(stage)) return;
      this.remaining--;
      const outcomeCode = CODES.has(code) ? code : "OTHER_PROTECTIVE_FAILURE";
      const count = (v: unknown, max: number): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(max, v) : 0);
      const warningCodes = Array.isArray(facts?.nativeWarningCodes)
        ? facts.nativeWarningCodes.filter((v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 9999).slice(0, 16)
        : [];
      this.emit(
        JSON.stringify({
          event: "routing_guard_diagnostic_v1",
          correlationId: safe.correlationId,
          stage,
          outcomeCode,
          costing: facts && ["auto", "truck", "other"].includes(facts.costing) ? facts.costing : "unknown",
          requestedDateTimeMode: facts && ["none", "depart_now", "depart_at"].includes(facts.requestedDateTimeMode) ? facts.requestedDateTimeMode : "unknown",
          requestedVariantCount:
            facts &&
            typeof facts.requestedVariantCount === "number" &&
            Number.isInteger(facts.requestedVariantCount) &&
            facts.requestedVariantCount >= 1 &&
            facts.requestedVariantCount <= 3
              ? facts.requestedVariantCount
              : null,
          returnedVariantCount: count(facts?.returnedVariantCount, 3),
          returnedVariantCountTruncated: facts?.returnedVariantCountTruncated === true,
          nativeWarningCodes: [...new Set(warningCodes)].sort((a, b) => a - b),
          warningCounts: {
            root: count(facts?.warningCounts?.root, 64),
            primary: count(facts?.warningCounts?.primary, 64),
            alternate: count(facts?.warningCounts?.alternate, 64),
            malformed: count(facts?.warningCounts?.malformed, 64)
          },
          nativeWarningsTruncated: facts?.nativeWarningsTruncated === true,
          algorithm: "not_reported",
          multipassCondition: "not_reported",
          // WAYPOINT also covers the origin in the existing classifier: do not guess.
          snapClassification:
            outcomeCode === "ROUTING_TARGET_NOT_ROUTABLE" &&
            closureGeometryValidated === true &&
            (stage === "waypoint_snap_validation" || stage === "route_final_validation")
              ? "destination"
              : "unknown",
          closureGeometryValidated: closureGeometryValidated === true
        })
      );
    } catch {
      /* Diagnostics must never change routing, retries or error handling. */
    }
  }
}
