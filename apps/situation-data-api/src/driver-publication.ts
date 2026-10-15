import type { Response } from "express";
import { DriverMeasurementError } from "./driver-measurements.js";

export type DriverPublicationKind = "aggregates" | "quality";
export interface DriverPublicationLease {
  assertCurrent(): Promise<void>;
}
export interface DriverPublicationPort {
  withLease<T>(request: { readonly kind: DriverPublicationKind }, work: (lease: DriverPublicationLease) => Promise<T>): Promise<T>;
}

const RESPONSE_STALL_MS = 15_000;
const unavailable = () => new DriverMeasurementError(503, "DRIVER_MEASUREMENTS_UNAVAILABLE");
const warnUnavailable = () => console.warn(JSON.stringify({
  event: "driver_report_publication_unavailable", code: "DRIVER_MEASUREMENTS_UNAVAILABLE"
}));

/**
 * HTTP lifecycle adapter only, not a Root lease implementation or drain proof.
 * The accepted Root port must hold its actual shared metadata/publication lease
 * until this callback settles, and must itself establish release/quiescence.
 * No production factory is bound here; an absent future port is fail-closed.
 */
export async function publishDriverReport(
  response: Response,
  kind: DriverPublicationKind,
  port: DriverPublicationPort | undefined,
  work: (lease: DriverPublicationLease) => Promise<unknown>
): Promise<void> {
  if (!port || typeof port.withLease !== "function" || (kind !== "aggregates" && kind !== "quality")) throw unavailable();

  let responseDone = response.writableFinished || response.closed;
  let responseError = false;
  let resolveResponse!: () => void;
  const completion = new Promise<void>(resolve => { resolveResponse = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = () => {
    responseDone = true;
    if (timer !== undefined) clearTimeout(timer);
    resolveResponse();
  };
  const destroyResponse = () => {
    // destroy() is only an HTTP action. It is not SQL cancellation, a completed
    // publication event, or a reason to release an unsettled work promise.
    if (!responseDone && !response.destroyed) {
      try { response.destroy(); } catch { /* Still wait for actual finish/close. */ }
    }
  };
  const failed = () => {
    responseError = true;
    destroyResponse();
  };
  // Install listeners before acquisition/work; finish may happen synchronously
  // during json(), while a client may close during the actual SQL query.
  response.on("finish", ended);
  response.on("close", ended);
  response.on("error", failed);
  if (responseDone) resolveResponse();
  else {
    timer = setTimeout(destroyResponse, RESPONSE_STALL_MS);
    timer.unref();
  }

  const inFlight: { callback?: Promise<void> } = {};
  let callbackStarted = false;
  let callbackSettled = false;
  let admitting = true;
  let scopeExited = false;
  const abortPrematurePublication = () => {
    if(inFlight.callback && !callbackSettled && (response.headersSent || response.writableEnded)) destroyResponse();
  };
  const publish = async (lease: DriverPublicationLease): Promise<void> => {
    try {
      // Always await the actual query, even if the response closes meanwhile.
      const result = await work(lease);
      await lease.assertCurrent();
      if (scopeExited || responseError || response.destroyed || response.closed) throw unavailable();
      if (!response.destroyed && !response.writableEnded) {
        if (response.headersSent) throw unavailable();
        response.json(result);
      }
      await completion;
    } catch (error) {
      if (response.headersSent || response.destroyed || response.writableEnded || responseDone) {
        destroyResponse();
        await completion;
      }
      throw error;
    }
  };

  try {
    await port.withLease({ kind }, lease => {
      if (!admitting || callbackStarted) {
        const rejected = Promise.reject(unavailable());
        void rejected.catch(() => undefined);
        return rejected;
      }
      callbackStarted = true;
      inFlight.callback = publish(lease).finally(() => { callbackSettled = true; });
      // A broken port must not turn a later actual SQL rejection into an
      // unhandled promise. The same callback is nevertheless awaited below.
      void inFlight.callback.catch(() => undefined);
      return inFlight.callback;
    });
    scopeExited = true;
    const prematureExit = !!inFlight.callback && !callbackSettled;
    abortPrematurePublication();
    if (!inFlight.callback) throw unavailable();
    await inFlight.callback;
    if(prematureExit)throw unavailable();
  } catch {
    scopeExited = true;
    abortPrematurePublication();
    // Even a prematurely rejecting port cannot make this adapter abandon work
    // already started. This does not repair or prove that port's Root custody.
    if (inFlight.callback) await inFlight.callback.catch(() => undefined);
    if (response.headersSent || response.destroyed || response.writableEnded || responseDone) {
      destroyResponse();
      await completion;
      warnUnavailable();
      return;
    }
    throw unavailable();
  } finally {
    admitting = false;
    if (timer !== undefined) clearTimeout(timer);
    response.off("finish", ended);
    response.off("close", ended);
    response.off("error", failed);
  }
}
