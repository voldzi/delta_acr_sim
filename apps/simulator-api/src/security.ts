import type { CorsOptions } from "cors";
import type { NextFunction, Request, Response } from "express";
import { appendFile } from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { ApiConfig, ApiPrincipalConfig, SimRole } from "./config.js";
import { problem } from "./http.js";

interface AuthenticatedPrincipal {
  actor: string;
  roles: SimRole[];
}

interface RoutePolicy {
  methods?: string[];
  pattern: RegExp;
  roles: SimRole[];
  publicRead?: boolean;
  audit?: {
    action: string;
    resourceType: string;
    resourceId?: (req: Request) => string | undefined;
  };
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const principalKey = Symbol("simPrincipal");

type AuthenticatedRequest = Request & {
  [principalKey]?: AuthenticatedPrincipal;
};

export class AuditLogger {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "sim-audit.jsonl");
  }

  async record(req: Request, entry: Record<string, unknown>): Promise<void> {
    const principal = getPrincipal(req);
    const event = {
      auditId: randomUUID(),
      timestamp: new Date().toISOString(),
      actor: principal?.actor ?? "anonymous",
      role: principal?.roles.join(",") ?? "none",
      correlationId: req.header("x-correlation-id") ?? randomUUID(),
      method: req.method,
      path: req.path,
      redactionApplied: true,
      ...entry
    };
    try {
      await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      console.error("Failed to append SIM audit event", error);
    }
  }
}

class InMemoryRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number
  ) {}

  check(key: string, now = Date.now()): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true };
    }
    existing.count += 1;
    if (existing.count <= this.maxRequests) {
      return { allowed: true };
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
}

const routePolicies: RoutePolicy[] = [
  { methods: ["GET"], pattern: /^\/health\/ready$/, roles: ["SIM_VIEWER"] },
  { methods: ["GET"], pattern: /^\/health\/dependencies$/, roles: ["SIM_VIEWER"] },
  { methods: ["GET"], pattern: /^\/metrics$/, roles: ["SIM_VIEWER"] },
  { methods: ["GET"], pattern: /^\/api\/v1\/scenarios$/, roles: ["SIM_VIEWER"], publicRead: true },
  { methods: ["POST"], pattern: /^\/api\/v1\/scenarios$/, roles: ["SIM_OPERATOR"], audit: { action: "scenario.create", resourceType: "scenario" } },
  { methods: ["GET"], pattern: /^\/api\/v1\/scenarios\/[^/]+$/, roles: ["SIM_VIEWER"], publicRead: true },
  {
    methods: ["PATCH"],
    pattern: /^\/api\/v1\/scenarios\/[^/]+$/,
    roles: ["SIM_OPERATOR"],
    audit: { action: "scenario.update", resourceType: "scenario", resourceId: scenarioIdFromPath }
  },
  {
    methods: ["DELETE"],
    pattern: /^\/api\/v1\/scenarios\/[^/]+$/,
    roles: ["SIM_OPERATOR"],
    audit: { action: "scenario.delete", resourceType: "scenario", resourceId: scenarioIdFromPath }
  },
  {
    methods: ["POST"],
    pattern: /^\/api\/v1\/scenarios\/[^/]+\/(?:start|step|pause|resume|stop|reset)$/,
    roles: ["SIM_OPERATOR"],
    audit: { action: "runtime.command", resourceType: "scenario", resourceId: scenarioIdFromPath }
  },
  { methods: ["GET"], pattern: /^\/api\/v1\/runtime\/(?:status|blocks|publisher)$/, roles: ["SIM_VIEWER"], publicRead: true },
  { methods: ["GET"], pattern: /^\/api\/v1\/runtime\/metrics$/, roles: ["SIM_VIEWER"] },
  {
    methods: ["POST", "DELETE"],
    pattern: /^\/api\/v1\/scenarios\/[^/]+\/faults(?:\/[^/]+)?$/,
    roles: ["SIM_OPERATOR"],
    audit: { action: "fault.change", resourceType: "scenario", resourceId: scenarioIdFromPath }
  },
  { methods: ["GET"], pattern: /^\/api\/v1\/scenarios\/[^/]+\/faults$/, roles: ["SIM_VIEWER"] },
  { methods: ["GET"], pattern: /^\/api\/v1\/publisher\/(?:status|queue)$/, roles: ["SIM_VIEWER"] },
  {
    methods: ["POST"],
    pattern: /^\/api\/v1\/publisher\/(?:test-connection|send-sample|queue\/retry|queue\/clear|stop)$/,
    roles: ["SIM_ADMIN"],
    audit: { action: "publisher.change", resourceType: "publisher" }
  },
  { methods: ["POST"], pattern: /^\/api\/v1\/ai\/scenario-drafts$/, roles: ["SIM_AI_USER"], audit: { action: "ai.draft.create", resourceType: "aiDraft" } },
  { methods: ["GET"], pattern: /^\/api\/v1\/ai\/scenario-drafts\/[^/]+$/, roles: ["SIM_AI_USER"] },
  { methods: ["POST"], pattern: /^\/api\/v1\/ai\/scenario-drafts\/[^/]+\/validate$/, roles: ["SIM_AI_USER"] },
  {
    methods: ["POST"],
    pattern: /^\/api\/v1\/ai\/scenario-drafts\/[^/]+\/(?:accept|reject)$/,
    roles: ["SIM_AI_USER"],
    audit: { action: "ai.draft.review", resourceType: "aiDraft", resourceId: draftIdFromPath }
  },
  { methods: ["GET"], pattern: /^\/api\/v1\/ai\/providers$/, roles: ["SIM_VIEWER"], publicRead: true },
  { methods: ["PATCH"], pattern: /^\/api\/v1\/ai\/config$/, roles: ["SIM_AI_ADMIN"], audit: { action: "ai.config.update", resourceType: "aiConfig" } }
];

const devPrincipal: AuthenticatedPrincipal = {
  actor: "anonymous-dev",
  roles: ["SIM_ADMIN", "SIM_OPERATOR", "SIM_VIEWER", "SIM_AI_USER", "SIM_AI_ADMIN"]
};

const publicReadPrincipal: AuthenticatedPrincipal = {
  actor: "public-read",
  roles: ["SIM_VIEWER"]
};

export function createCorsOptions(config: ApiConfig): CorsOptions {
  const origins = config.apiCorsOrigins ?? [];
  if (origins.length > 0) {
    return {
      origin(origin, callback) {
        callback(null, !origin || origins.includes(origin));
      }
    };
  }
  if (config.apiAuthRequired) {
    return { origin: false };
  }
  return {};
}

export function createSecurityMiddleware(config: ApiConfig, audit: AuditLogger) {
  const rateLimiter = new InMemoryRateLimiter(config.apiRateLimitWindowMs ?? 60_000, config.apiRateLimitMaxRequests ?? 300);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method === "OPTIONS" || isPublicPath(req.path)) {
      next();
      return;
    }

    const policy = findPolicy(req);
    if (!policy) {
      next();
      return;
    }

    if (config.apiAuthRequired && config.apiPublicRead && req.method === "GET" && policy.publicRead) {
      setPrincipal(req, publicReadPrincipal);
      next();
      return;
    }

    const principal = config.apiAuthRequired ? authenticate(req, config.apiPrincipals ?? []) : devPrincipal;
    if (!principal) {
      await audit.record(req, { action: "auth.failure", resourceType: "api", result: "DENIED", statusCode: 401 });
      problem(req, res, 401, "UNAUTHORIZED", "Missing or invalid bearer token.");
      return;
    }
    setPrincipal(req, principal);

    if (!hasRequiredRole(principal, policy.roles)) {
      await audit.record(req, { action: "auth.forbidden", resourceType: "api", result: "DENIED", statusCode: 403 });
      problem(req, res, 403, "FORBIDDEN", "Bearer token does not grant the required SIM role.");
      return;
    }

    const rateLimit = rateLimiter.check(`${principal.actor}:${clientAddress(req)}`);
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      await audit.record(req, { action: "rate_limit.exceeded", resourceType: "api", result: "DENIED", statusCode: 429 });
      problem(req, res, 429, "RATE_LIMITED", "Too many SIM API requests.");
      return;
    }

    if (policy.audit) {
      res.on("finish", () => {
        void audit.record(req, {
          action: policy.audit?.action,
          resourceType: policy.audit?.resourceType,
          resourceId: policy.audit?.resourceId?.(req),
          result: res.statusCode < 400 ? "SUCCESS" : "FAILED",
          statusCode: res.statusCode
        });
      });
    }

    next();
  };
}

function isPublicPath(path: string): boolean {
  return path === "/health/live" || path.startsWith("/mock-cop/");
}

function findPolicy(req: Request): RoutePolicy | undefined {
  return routePolicies.find((policy) => (!policy.methods || policy.methods.includes(req.method)) && policy.pattern.test(req.path));
}

function authenticate(req: Request, principals: ApiPrincipalConfig[]): AuthenticatedPrincipal | undefined {
  const token = bearerToken(req.header("authorization"));
  if (!token) {
    return undefined;
  }
  const principal = principals.find((candidate) => secureCompare(candidate.token, token));
  return principal ? { actor: principal.actor, roles: principal.roles } : undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1]?.trim();
}

function secureCompare(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function hasRequiredRole(principal: AuthenticatedPrincipal, requiredRoles: SimRole[]): boolean {
  return requiredRoles.some((requiredRole) => principal.roles.some((role) => roleImplies(role, requiredRole)));
}

function roleImplies(actual: SimRole, required: SimRole): boolean {
  if (actual === "SIM_ADMIN" || actual === required) {
    return true;
  }
  if (actual === "SIM_OPERATOR" && required === "SIM_VIEWER") {
    return true;
  }
  return actual === "SIM_AI_ADMIN" && required === "SIM_AI_USER";
}

function clientAddress(req: Request): string {
  const forwardedFor = req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || req.ip || req.socket.remoteAddress || "unknown";
}

function setPrincipal(req: Request, principal: AuthenticatedPrincipal): void {
  (req as AuthenticatedRequest)[principalKey] = principal;
}

function getPrincipal(req: Request): AuthenticatedPrincipal | undefined {
  return (req as AuthenticatedRequest)[principalKey];
}

function scenarioIdFromPath(req: Request): string | undefined {
  return /^\/api\/v1\/scenarios\/([^/]+)/.exec(req.path)?.[1];
}

function draftIdFromPath(req: Request): string | undefined {
  return /^\/api\/v1\/ai\/scenario-drafts\/([^/]+)/.exec(req.path)?.[1];
}
