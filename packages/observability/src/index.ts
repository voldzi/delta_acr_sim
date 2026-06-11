import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

interface HeaderCarrier {
  [key: string]: string | string[] | undefined;
}

interface RequestLike {
  method?: string;
  path?: string;
  originalUrl?: string;
  url?: string;
  headers?: HeaderCarrier;
  header?: (name: string) => string | undefined;
  ip?: string;
}

interface ResponseLike {
  statusCode?: number;
  on?: (event: "finish" | "close", listener: () => void) => void;
}

type NextFunctionLike = () => void;

export interface ObservabilityOptions {
  serviceName: string;
  serviceVersion?: string;
}

export interface ObservabilityRuntime {
  enabled: boolean;
  serviceName: string;
  shutdown(): Promise<void>;
}

interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

interface SpanPayload {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status?: {
    code: number;
  };
}

type AttributeValue = string | number | boolean;

interface OtlpAttribute {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
  };
}

const activeContext = new AsyncLocalStorage<TraceContext>();
const inFlightExports = new Set<Promise<void>>();

let currentOptions: ObservabilityOptions | undefined;
let enabled = false;
let exporterEndpoint: string | undefined;

export async function initializeObservability(options: ObservabilityOptions): Promise<ObservabilityRuntime> {
  currentOptions = options;
  enabled = isOpenTelemetryEnabled();
  exporterEndpoint = enabled ? resolveTraceExporterUrl() : undefined;
  if (enabled) {
    console.log(`OpenTelemetry OTLP tracing enabled for ${options.serviceName}`);
  }
  return {
    enabled,
    serviceName: options.serviceName,
    shutdown: shutdownObservability
  };
}

export function createHttpRequestTracingMiddleware(serviceName: string) {
  return (req: RequestLike, res: ResponseLike, next: NextFunctionLike): void => {
    const method = req.method ?? "UNKNOWN";
    const path = routePath(req);
    const startedAt = Date.now();
    const startTimeUnixNano = unixNanoNow();
    const inherited = parseTraceparent(headerValue(req, "traceparent"));
    const traceContext: TraceContext = {
      traceId: inherited?.traceId ?? randomHex(16),
      spanId: randomHex(8),
      parentSpanId: inherited?.spanId
    };

    let finished = false;
    const finishSpan = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      const statusCode = res.statusCode ?? 0;
      const attributes = compactAttributes({
        "http.request.method": method,
        "url.path": path,
        "url.full": req.originalUrl ?? req.url,
        "client.address": req.ip,
        "service.name": serviceName,
        "csm.correlation_id": headerValue(req, "x-correlation-id"),
        "csm.request_id": headerValue(req, "x-request-id"),
        "http.response.status_code": statusCode,
        "http.server.duration_ms": Date.now() - startedAt
      });
      exportSpan({
        traceId: traceContext.traceId,
        spanId: traceContext.spanId,
        parentSpanId: traceContext.parentSpanId,
        name: `${method} ${path}`,
        kind: 2,
        startTimeUnixNano,
        endTimeUnixNano: unixNanoNow(),
        attributes,
        status: statusCode >= 500 ? { code: 2 } : undefined
      });
    };

    res.on?.("finish", finishSpan);
    res.on?.("close", finishSpan);
    activeContext.run(traceContext, next);
  };
}

export function activeTraceContext(): { traceId?: string; spanId?: string } {
  const traceContext = activeContext.getStore();
  if (!traceContext) {
    return {};
  }
  return {
    traceId: traceContext.traceId,
    spanId: traceContext.spanId
  };
}

export async function shutdownObservability(): Promise<void> {
  const pending = Array.from(inFlightExports);
  if (pending.length === 0) {
    return;
  }
  await Promise.allSettled(pending);
}

function exportSpan(span: SpanPayload): void {
  if (!enabled || !exporterEndpoint || !currentOptions) {
    return;
  }
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: compactAttributes({
            "service.name": currentOptions.serviceName,
            "service.version": currentOptions.serviceVersion ?? process.env.npm_package_version ?? "0.1.0",
            "deployment.environment": process.env.NODE_ENV ?? "development"
          })
        },
        scopeSpans: [
          {
            scope: {
              name: "@csm-sim/observability",
              version: "0.1.0"
            },
            spans: [span]
          }
        ]
      }
    ]
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), exportTimeoutMs());
  const promise = fetch(exporterEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: controller.signal
  })
    .then(async (response) => {
      if (!response.ok && process.env.OTEL_DIAGNOSTIC_LOGS === "true") {
        console.warn(`OTLP trace export failed with HTTP ${response.status}`);
      }
    })
    .catch((error: unknown) => {
      if (process.env.OTEL_DIAGNOSTIC_LOGS === "true") {
        console.warn("OTLP trace export failed", error);
      }
    })
    .finally(() => {
      clearTimeout(timeout);
      inFlightExports.delete(promise);
    });
  inFlightExports.add(promise);
}

function isOpenTelemetryEnabled(): boolean {
  if (process.env.OTEL_SDK_DISABLED === "true") {
    return false;
  }
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_SDK_DISABLED === "false");
}

function resolveTraceExporterUrl(): string | undefined {
  if (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    return process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  }
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`;
  }
  return undefined;
}

function exportTimeoutMs(): number {
  const parsed = Number(process.env.OTEL_EXPORT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2_000;
}

function routePath(req: RequestLike): string {
  return req.path ?? req.url ?? "unknown";
}

function headerValue(req: RequestLike, name: string): string | undefined {
  const fromHelper = req.header?.(name);
  if (fromHelper) {
    return fromHelper;
  }
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseTraceparent(value: string | undefined): TraceContext | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value.trim().split("-");
  if (parts.length < 4 || parts[0] !== "00") {
    return undefined;
  }
  const traceId = parts[1];
  const spanId = parts[2];
  if (!traceId || !spanId || !/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) {
    return undefined;
  }
  return {
    traceId,
    spanId
  };
}

function compactAttributes(attributes: Record<string, AttributeValue | undefined>): OtlpAttribute[] {
  return Object.entries(attributes)
    .filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined)
    .map(([key, value]) => ({ key, value: otlpValue(value) }));
}

function otlpValue(value: AttributeValue): OtlpAttribute["value"] {
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}

function unixNanoNow(): string {
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
