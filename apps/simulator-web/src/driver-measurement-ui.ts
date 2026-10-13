import type { DriverMeasurementEvaluationResponse } from "./types";

export const DRIVER_EVALUATION_POLL_MS = 60_000;
export const DRIVER_EVALUATION_MAX_AGE_MS = 90_000;

/** Backend receipt age plus monotonic time; the browser clock cannot freshen a report. */
export function driverEvaluationView(response: DriverMeasurementEvaluationResponse | undefined, elapsedMs = 0) {
  const ageMs =
    response?.reportAgeSeconds === null || response?.reportAgeSeconds === undefined ? null : response.reportAgeSeconds * 1000 + Math.max(0, elapsedMs);
  const status = response?.status === "current" && ageMs !== null && ageMs > DRIVER_EVALUATION_MAX_AGE_MS ? "stale" : (response?.status ?? "unavailable");
  const report = response?.report;
  const currentWindowEndsMs = report ? Math.floor(Date.parse(report.asOf) / 300_000) * 300_000 + 300_000 : null;
  const currentWindowOpen = Boolean(report && ageMs !== null && currentWindowEndsMs !== null && Date.parse(report.asOf) + ageMs < currentWindowEndsMs);
  const eta =
    report?.summary.eta.find((row) => row.routingDataset === report.routingDataset && row.attestedContributorCount >= 5 && row.observationCount >= 10) ?? null;
  return {
    status,
    ageMs,
    report,
    currentWindowEndsAt: currentWindowEndsMs === null ? null : new Date(currentWindowEndsMs).toISOString(),
    currentWindowOpen,
    currentEvidenceAvailable: status === "current" && currentWindowOpen && Boolean(report && report.summary.speed.currentQualityGroupCount > 0),
    eta,
    etaErrorSeconds: eta?.medianAbsoluteErrorSeconds ?? null,
    etaErrorPercent: eta?.medianAbsoluteErrorPercent ?? null
  };
}

interface PollOptions<T> {
  load(signal: AbortSignal): Promise<T>;
  deliver(value: T): void;
  fail(): void;
  visible(): boolean;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clear?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** At most one request per minute, no hidden-tab requests or late result after disposal. */
export function startDriverEvaluationPolling<T>(options: PollOptions<T>) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setTimeout;
  const clear = options.clear ?? clearTimeout;
  let stopped = false,
    inflight = false,
    lastStart = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const clearTimer = () => {
    if (timer !== undefined) clear(timer);
    timer = undefined;
  };
  const arm = () => {
    clearTimer();
    if (!stopped && options.visible() && !inflight) timer = schedule(() => void tick(), Math.max(0, DRIVER_EVALUATION_POLL_MS - (now() - lastStart)));
  };
  const tick = async () => {
    clearTimer();
    if (stopped || !options.visible() || inflight) return;
    if (now() - lastStart < DRIVER_EVALUATION_POLL_MS) {
      arm();
      return;
    }
    lastStart = now();
    inflight = true;
    const request = new AbortController();
    controller = request;
    try {
      const result = await options.load(request.signal);
      if (!stopped && !request.signal.aborted && options.visible()) options.deliver(result);
    } catch {
      if (!stopped && !request.signal.aborted && options.visible()) options.fail();
    } finally {
      inflight = false;
      if (controller === request) controller = undefined;
      arm();
    }
  };
  void tick();
  return {
    visibilityChanged() {
      if (!options.visible()) {
        clearTimer();
        controller?.abort();
      } else if (!stopped && !inflight) void tick();
    },
    stop() {
      stopped = true;
      clearTimer();
      controller?.abort();
    }
  };
}
