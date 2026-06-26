import type { CorsOptions } from "cors";
import type { NextFunction, Request, Response } from "express";
import { appendFile } from "node:fs/promises";
import { createPublicKey, createVerify, randomUUID, timingSafeEqual, type JsonWebKey as NodeJsonWebKey } from "node:crypto";
import { join } from "node:path";
import type { ApiConfig, ApiPrincipalConfig, SimRole } from "./config.js";
import { problem } from "./http.js";

interface AuthenticatedPrincipal {
  actor: string;
  authMode?: "public" | "token" | "oidc" | "dev";
  email?: string;
  roles: SimRole[];
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  aud?: string | string[];
  azp?: string;
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  name?: string;
  nbf?: number;
  preferred_username?: string;
  realm_access?: {
    roles?: string[];
  };
  resource_access?: Record<string, { roles?: string[] }>;
  sub?: string;
}

interface JsonWebKeySet {
  keys?: Jwk[];
}

interface CachedJwks {
  expiresAt: number;
  keys: Jwk[];
}

type Jwk = NodeJsonWebKey & {
  kid?: string;
};

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
const jwksCache = new Map<string, CachedJwks>();
const authClockSkewSeconds = 30;
const jwksCacheMs = 5 * 60 * 1000;

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
  { methods: ["GET"], pattern: /^\/api\/v1\/operations\/summary$/, roles: ["SIM_VIEWER"], publicRead: true },
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
  authMode: "dev",
  roles: ["SIM_ADMIN", "SIM_OPERATOR", "SIM_VIEWER", "SIM_AI_USER", "SIM_AI_ADMIN"]
};

const publicReadPrincipal: AuthenticatedPrincipal = {
  actor: "public-read",
  authMode: "public",
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

    if (config.apiAuthRequired && config.apiPublicRead && req.method === "GET" && policy.publicRead && !req.header("authorization")) {
      setPrincipal(req, publicReadPrincipal);
      next();
      return;
    }

    const principal = config.apiAuthRequired ? await authenticate(req, config) : devPrincipal;
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

    if (!isPublicReadRequest(req, policy)) {
      const rateLimit = rateLimiter.check(`${principal.actor}:${clientAddress(req)}`);
      if (!rateLimit.allowed) {
        res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
        await audit.record(req, { action: "rate_limit.exceeded", resourceType: "api", result: "DENIED", statusCode: 429 });
        problem(req, res, 429, "RATE_LIMITED", "Too many SIM API requests.");
        return;
      }
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

function isPublicReadRequest(req: Request, policy: RoutePolicy): boolean {
  return req.method === "GET" && Boolean(policy.publicRead);
}

function isPublicPath(path: string): boolean {
  return path === "/health/live" || path.startsWith("/mock-cop/");
}

function findPolicy(req: Request): RoutePolicy | undefined {
  return routePolicies.find((policy) => (!policy.methods || policy.methods.includes(req.method)) && policy.pattern.test(req.path));
}

async function authenticate(req: Request, config: ApiConfig): Promise<AuthenticatedPrincipal | undefined> {
  const token = bearerToken(req.header("authorization"));
  if (!token) {
    return undefined;
  }
  const mode = config.apiAuthMode ?? "token";
  if (mode !== "oidc") {
    const principal = authenticateStaticToken(token, config.apiPrincipals ?? []);
    if (principal) {
      return principal;
    }
  }
  if (mode !== "token") {
    return authenticateOidcToken(token, config);
  }
  return undefined;
}

function authenticateStaticToken(token: string, principals: ApiPrincipalConfig[]): AuthenticatedPrincipal | undefined {
  const principal = principals.find((candidate) => secureCompare(candidate.token, token));
  return principal ? { actor: principal.actor, authMode: "token", roles: principal.roles } : undefined;
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

async function authenticateOidcToken(token: string, config: ApiConfig): Promise<AuthenticatedPrincipal | undefined> {
  const issuer = config.apiOidcIssuer?.trim();
  if (!issuer) {
    return undefined;
  }
  const decoded = decodeJwt(token);
  if (!decoded || decoded.header.alg !== "RS256" || !decoded.header.kid) {
    return undefined;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (decoded.payload.iss !== issuer) {
    return undefined;
  }
  if (!decoded.payload.exp || decoded.payload.exp <= nowSeconds - authClockSkewSeconds) {
    return undefined;
  }
  if (decoded.payload.nbf && decoded.payload.nbf > nowSeconds + authClockSkewSeconds) {
    return undefined;
  }
  if (!matchesAllowedClient(decoded.payload, config)) {
    return undefined;
  }
  const key = await findJwkForToken(issuer, decoded.header.kid, config);
  if (!key || !verifyJwtSignature(token, key)) {
    return undefined;
  }
  const roles = mapOidcRoles(tokenRoles(decoded.payload, config));
  const subjectId = decoded.payload.sub?.trim();
  if (!subjectId || roles.length === 0) {
    return undefined;
  }
  const actor = decoded.payload.preferred_username?.trim()
    || decoded.payload.email?.trim()
    || decoded.payload.name?.trim()
    || subjectId;
  return {
    actor,
    authMode: "oidc",
    ...(decoded.payload.email?.trim() ? { email: decoded.payload.email.trim() } : {}),
    roles
  };
}

function decodeJwt(token: string): { header: JwtHeader; payload: JwtPayload; signedContent: string; signature: Buffer } | null {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    return null;
  }
  try {
    return {
      header: JSON.parse(base64UrlToBuffer(encodedHeader).toString("utf8")) as JwtHeader,
      payload: JSON.parse(base64UrlToBuffer(encodedPayload).toString("utf8")) as JwtPayload,
      signature: base64UrlToBuffer(encodedSignature),
      signedContent: `${encodedHeader}.${encodedPayload}`
    };
  } catch {
    return null;
  }
}

async function findJwkForToken(issuer: string, kid: string, config: ApiConfig): Promise<Jwk | null> {
  const jwksUri = config.apiOidcJwksUri ?? `${issuer}/protocol/openid-connect/certs`;
  const jwks = await fetchJwks(jwksUri);
  return jwks.find((key) => key.kid === kid) ?? null;
}

async function fetchJwks(jwksUri: string): Promise<Jwk[]> {
  const cached = jwksCache.get(jwksUri);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }
  try {
    const response = await fetch(jwksUri);
    if (!response.ok) {
      return [];
    }
    const jwks = (await response.json()) as JsonWebKeySet;
    const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
    jwksCache.set(jwksUri, { expiresAt: Date.now() + jwksCacheMs, keys });
    return keys;
  } catch {
    return [];
  }
}

function verifyJwtSignature(token: string, key: Jwk): boolean {
  const decoded = decodeJwt(token);
  if (!decoded) {
    return false;
  }
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(decoded.signedContent);
    verifier.end();
    return verifier.verify(createPublicKey({ format: "jwk", key }), decoded.signature);
  } catch {
    return false;
  }
}

function matchesAllowedClient(payload: JwtPayload, config: ApiConfig): boolean {
  const allowedClients = config.apiOidcAllowedClients ?? [];
  if (allowedClients.length === 0) {
    return true;
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  return allowedClients.some((client) => payload.azp === client || audiences.includes(client));
}

function tokenRoles(payload: JwtPayload, config: ApiConfig): string[] {
  const clientId = config.apiOidcClientId?.trim();
  return Array.from(new Set([
    ...(payload.realm_access?.roles ?? []),
    ...(clientId ? payload.resource_access?.[clientId]?.roles ?? [] : [])
  ]));
}

function mapOidcRoles(roles: string[]): SimRole[] {
  const mapped = new Set<SimRole>();
  const normalized = new Set(roles.map((role) => role.trim()).filter(Boolean));
  if (hasAnyRole(normalized, ["SIM_ADMIN", "sim_admin", "csm-sim-admin", "cop_admin"])) {
    mapped.add("SIM_ADMIN");
  }
  if (hasAnyRole(normalized, ["SIM_OPERATOR", "sim_operator", "csm-sim-operator", "cop_operator"])) {
    mapped.add("SIM_OPERATOR");
    mapped.add("SIM_VIEWER");
  }
  if (hasAnyRole(normalized, ["SIM_VIEWER", "sim_viewer", "csm-sim-viewer", "cop_user"])) {
    mapped.add("SIM_VIEWER");
  }
  if (hasAnyRole(normalized, ["SIM_AI_ADMIN", "sim_ai_admin", "csm-sim-ai-admin"])) {
    mapped.add("SIM_AI_ADMIN");
    mapped.add("SIM_AI_USER");
  }
  if (hasAnyRole(normalized, ["SIM_AI_USER", "sim_ai_user", "csm-sim-ai-user"])) {
    mapped.add("SIM_AI_USER");
  }
  return Array.from(mapped);
}

function hasAnyRole(actualRoles: Set<string>, acceptedRoles: string[]): boolean {
  return acceptedRoles.some((role) => actualRoles.has(role));
}

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function clearJwksCacheForTests(): void {
  jwksCache.clear();
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
