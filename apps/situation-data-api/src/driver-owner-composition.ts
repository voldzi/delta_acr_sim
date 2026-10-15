import { lstat, realpath, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { RequestHandler } from "express";
import type {
  DriverGuardedExecutionPort,
  DriverGuardedReadAdmissionPort,
  DriverGuardedRequestContextPort,
  DriverGuardedStoreOptions
} from "./driver-guarded-execution-port.js";
import type { DriverRetentionConsumer } from "./driver-retention-lifecycle.js";

const ROOT_DIRECTORY = "/opt/cop-account-safety";
const PREFIX = "/api/v1/internal/driver-measurements/v1";
const MODULES = Object.freeze({
  execution: `${ROOT_DIRECTORY}/driver-root-channel.mjs`,
  admission: `${ROOT_DIRECTORY}/driver-root-inspect.mjs`,
  requestScope: `${ROOT_DIRECTORY}/driver-root-context.mjs`,
  retention: `${ROOT_DIRECTORY}/driver-root-retention.mjs`
});

/** HTTP routing metadata, never a signed Root lease, permit or drain proof. */
export interface DriverRootHttpScope {
  readonly method: string;
  readonly path: string;
  readonly authorization: string;
  readonly actor: string;
  readonly actorSignature: string;
  readonly body: unknown;
}
export interface DriverRootRequestScope {
  readonly context: DriverGuardedRequestContextPort;
  run<T>(scope: DriverRootHttpScope, work: () => T): T;
}
export interface DriverOwnerBindings {
  readonly execution: DriverGuardedExecutionPort;
  readonly admission: DriverGuardedReadAdmissionPort;
  readonly requestScope: DriverRootRequestScope;
  readonly retentionConsumer: DriverRetentionConsumer;
}
export interface DriverOwnerComposition {
  readonly driverMeasurements: {
    /** Presence, including an empty object, explicitly opts out of legacy SQL. */
    readonly guarded: DriverGuardedStoreOptions;
    readonly guardedRequestContext?: DriverGuardedRequestContextPort;
    readonly retentionConsumer?: DriverRetentionConsumer;
  };
  readonly driverScopeMiddleware: RequestHandler;
}

function unbound(): DriverOwnerComposition {
  const driverScopeMiddleware: RequestHandler = (_request, _response, next) => next();
  return Object.freeze({
    driverMeasurements: Object.freeze({ guarded: Object.freeze({}) }),
    driverScopeMiddleware
  });
}

/**
 * Pure dependency composition for already obtained, typed ports. This test seam
 * confers no authority: only the fixed production loader below selects modules;
 * the real Root ports independently verify each delivery and operation.
 */
export function composeDriverOwnerBindings(bindings: DriverOwnerBindings): DriverOwnerComposition {
  const driverScopeMiddleware: RequestHandler = (request, _response, next) => {
    const method = request.method, path = request.path;
    if (!((method === "DELETE" && path === `${PREFIX}/contributions`) ||
      (method === "POST" && path === `${PREFIX}/account-erasure-operations`))) {
      next();
      return;
    }
    let forwarded = false;
    try {
      bindings.requestScope.run({
        method, path,
        authorization: request.get("authorization") ?? "",
        actor: request.get("x-cop-actor") ?? "",
        actorSignature: request.get("x-cop-actor-signature") ?? "",
        body: request.body as unknown
      }, () => {
        forwarded = true;
        next();
      });
    } catch {
      // A malformed scope must not pre-empt normal handler authentication/body
      // errors. No Root context is available on this unbound continuation.
      // Never forward twice if run() already invoked its work callback.
      if (!forwarded) next();
    }
  };
  return Object.freeze({
    driverMeasurements: Object.freeze({
      guarded: Object.freeze({ execution: bindings.execution, admission: bindings.admission }),
      guardedRequestContext: bindings.requestScope.context,
      retentionConsumer: bindings.retentionConsumer
    }),
    driverScopeMiddleware
  });
}

async function verifyFixedModuleCustody(): Promise<void> {
  const modulePaths: readonly string[] = Object.values(MODULES);
  for (const path of ["/", "/opt", ROOT_DIRECTORY, ...modulePaths]) {
    const stat = await lstat(path);
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.isSymbolicLink() ||
      (modulePaths.includes(path) ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) {
      throw new Error("owner_code_custody");
    }
    if (await realpath(path) !== path) throw new Error("owner_code_path");
  }
  // Inspect the entire ordinary local dependency closure BEFORE any import can
  // execute. Entry-file ownership alone does not protect imported helpers.
  let entries = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("owner_code_depth");
    for (const name of await readdir(directory)) {
      if (++entries > 20_000) throw new Error("owner_code_size");
      const path = `${directory}/${name}`, stat = await lstat(path);
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.isSymbolicLink() ||
        (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
        throw new Error("owner_code_custody");
      }
      if (stat.isDirectory()) await visit(path, depth + 1);
    }
  };
  await visit(ROOT_DIRECTORY, 0);
}

function factory(module: unknown, name: string): () => unknown {
  if (module === null || typeof module !== "object") throw new Error("owner_factory_missing");
  const value = (module as Record<string, unknown>)[name];
  if (typeof value !== "function") throw new Error("owner_factory_missing");
  return value as () => unknown;
}
function method(value: unknown, name: string): boolean {
  return value !== null && typeof value === "object" && typeof (value as Record<string, unknown>)[name] === "function";
}

/**
 * Only these fixed, reviewed COP owner factories may compose the production
 * service. No environment-selected path, callback factory, transport or fallback.
 * Code custody/type checks are NOT Root acceptance, enrollment or freshness.
 */
export async function loadProductionDriverOwnerComposition(): Promise<DriverOwnerComposition> {
  try {
    await verifyFixedModuleCustody();
    const executionModule: unknown = await import(pathToFileURL(MODULES.execution).href);
    const admissionModule: unknown = await import(pathToFileURL(MODULES.admission).href);
    const scopeModule: unknown = await import(pathToFileURL(MODULES.requestScope).href);
    const retentionModule: unknown = await import(pathToFileURL(MODULES.retention).href);
    const executionFactory = factory(executionModule, "createProductionDriverRootPort");
    const admissionFactory = factory(admissionModule, "createProductionDriverReadAdmissionPort");
    const requestScopeFactory = factory(scopeModule, "createProductionDriverRequestScope");
    const retentionFactory = factory(retentionModule, "createProductionDriverRetentionConsumer");
    const execution = executionFactory();
    const admission = admissionFactory();
    const requestScope = requestScopeFactory();
    const retentionConsumer = retentionFactory();
    if (!method(execution, "execute") || !method(execution, "probe") || !method(admission, "inspect") ||
      !method(requestScope, "run") || !method((requestScope as { context?: unknown }).context, "current") ||
      !method(retentionConsumer, "execute") ||
      (retentionConsumer as { owner?: unknown }).owner !== "sim_driver_measurements") {
      throw new Error("owner_port_missing");
    }
    return composeDriverOwnerBindings({
      execution: execution as DriverGuardedExecutionPort,
      admission: admission as DriverGuardedReadAdmissionPort,
      requestScope: requestScope as DriverRootRequestScope,
      retentionConsumer: retentionConsumer as DriverRetentionConsumer
    });
  } catch {
    console.warn(JSON.stringify({ event: "driver_owner_authority_unavailable", code: "OWNER_BINDING_UNAVAILABLE" }));
    return unbound();
  }
}
