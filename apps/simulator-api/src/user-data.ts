/** New canonical-owner composition. Disabled by default; no legacy adoption. */
import express, { type Request, type Response } from "express";
import pg from "pg";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, lstat, realpath, readdir, unlink, rmdir, writeFile, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { UserLedger } from "../../../packages/sim-user-data/ledger.mjs";
import { loadSimUserAuthority } from "../../../packages/sim-user-data/bootstrap.mjs";
import { attachSimPgErrorObservers } from "../../../packages/sim-user-data/pg-errors.mjs";
import { canonicalOwnerKey, simOwnerAlias, signSimOwner, SIM_USER_DATA_CONTRACT, SIM_USER_SCOPE } from "../../../packages/sim-user-data/claims.mjs";
import { verifyCleanActor } from "../../../packages/clean-lifecycle/http.mjs";
import { completedReplayEnabled } from "../../../packages/clean-lifecycle/completed-replay.mjs";
import { AuditLogger, authenticatedCanonicalOwner, createSecurityMiddleware, createCorsOptions } from "./security.js";
import type { ApiConfig } from "./config.js";
import { createApp, type AppContext } from "./app.js";
import cors from "cors";

export interface SimUserDataSettings {
  databaseUrl: string;
  root: string;
  environmentId: string;
  resetEpoch: string;
  tokensNotBefore: number;
  issuer: string;
  ownerSecret: string;
  serviceToken: string;
  actorSecret: string;
  routerActorSecret: string;
  routerUrl: string;
  routerToken: string;
  mode: "isolated-sim-user-data-v1" | "production-sim-user-data-v1";
}
const PREFIX = "/api/v1/internal/sim-user-data/v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const files = new Set(["sim-store.json", "publisher-queue.json", "sim-audit.jsonl", ".owner-scope.json"]);
const uid = () => {
  if (typeof process.getuid !== "function") throw Error("SIM_USER_POSIX_REQUIRED");
  return process.getuid();
};
class AnonymousAuthAudit extends AuditLogger {
  override async record(): Promise<void> {
    /* No display identity or request path is retained outside an owned directory. */
  }
}
export function simUserDataSettings(env = process.env): SimUserDataSettings | undefined {
  if (env.SIM_USER_DATA_ENABLED === undefined || env.SIM_USER_DATA_ENABLED === "false") return;
  if (env.SIM_USER_DATA_ENABLED !== "true" || !["isolated-sim-user-data-v1", "production-sim-user-data-v1"].includes(env.SIM_USER_DATA_MODE ?? ""))
    throw Error("SIM_USER_DATA_MODE_NOT_ACCEPTED");
  const s = {
    databaseUrl: env.SIM_USER_DATA_DATABASE_URL!,
    root: env.SIM_USER_DATA_ROOT!,
    environmentId: env.SIM_USER_DATA_ENVIRONMENT_ID!,
    resetEpoch: env.SIM_USER_DATA_RESET_EPOCH!,
    tokensNotBefore: Number(env.SIM_USER_DATA_TOKENS_NOT_BEFORE),
    issuer: env.SIM_OIDC_ISSUER!,
    ownerSecret: env.SIM_USER_DATA_OWNER_SECRET!,
    serviceToken: env.SIM_USER_DATA_COP_TOKEN!,
    actorSecret: env.SIM_USER_DATA_COP_ACTOR_SECRET!,
    routerActorSecret: env.SIM_USER_DATA_ROUTER_ACTOR_SECRET!,
    routerUrl: env.SIM_AI_ROUTER_BASE_URL!,
    routerToken: env.SIM_AI_ROUTER_SIM_TOKEN!,
    mode: env.SIM_USER_DATA_MODE as SimUserDataSettings["mode"]
  };
  validateSettings(s);
  return s;
}
function validateSettings(s: SimUserDataSettings) {
  if (
    !["isolated-sim-user-data-v1", "production-sim-user-data-v1"].includes(s.mode) ||
    (process.env.NODE_ENV === "production" && s.mode !== "production-sim-user-data-v1")
  )
    throw Error("SIM_USER_DATA_ISOLATION_MODE_REQUIRED");
  if (
    !uuid.test(s.environmentId) ||
    !uuid.test(s.resetEpoch) ||
    !Number.isSafeInteger(s.tokensNotBefore) ||
    s.tokensNotBefore <= 0 ||
    !/^https:\/\/[^\s]+$/.test(s.issuer) ||
    ![s.ownerSecret, s.serviceToken, s.actorSecret, s.routerActorSecret, s.routerToken].every((x) => typeof x === "string" && x.length >= 32) ||
    !s.databaseUrl ||
    !s.root
  )
    throw Error("SIM_USER_DATA_CONFIGURATION_REQUIRED");
  const url = new URL(s.routerUrl);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["ai-router-api", "127.0.0.1"].includes(url.hostname) ||
    url.pathname !== "/"
  )
    throw Error("SIM_USER_DATA_ROUTER_TARGET_INVALID");
}

export async function createOwnedSimulatorApp(config: ApiConfig, s: SimUserDataSettings) {
  validateSettings(s);
  if (config.apiAuthRequired !== true || !["oidc", "hybrid"].includes(config.apiAuthMode ?? "") || config.apiOidcIssuer !== s.issuer)
    throw Error("SIM_USER_DATA_VERIFIED_OIDC_REQUIRED");
  if (config.publisherMode === "LIVE") throw Error("SIM_USER_DATA_LIVE_PUBLISH_NOT_ACCEPTED");
  // Never hide/adopt old unbound content merely by selecting a new owner root.
  for (const name of ["sim-store.json", "publisher-queue.json", "sim-audit.jsonl"]) {
    const file = join(config.dataDir, name);
    try {
      const st = await lstat(file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw Error("SIM_USER_LEGACY_UNPROVEN");
      if (name === "sim-audit.jsonl") {
        if (st.size !== 0) throw Error("SIM_USER_LEGACY_RESET_REQUIRED");
      } else {
        if (st.size > 4 * 1024 * 1024) throw Error("SIM_USER_LEGACY_UNPROVEN");
        const x = JSON.parse(await readFile(file, "utf8"));
        if (
          name === "sim-store.json" &&
          (Object.keys(x).sort().join(",") !== "aiConfig,drafts,runtime,scenarios" || !Array.isArray(x.scenarios) || !Array.isArray(x.drafts))
        )
          throw Error("SIM_USER_LEGACY_UNPROVEN");
        if (
          name === "publisher-queue.json" &&
          (Object.keys(x).sort().join(",") !== "items,publishingEnabled" || !Array.isArray(x.items) || typeof x.publishingEnabled !== "boolean")
        )
          throw Error("SIM_USER_LEGACY_UNPROVEN");
        if (name === "sim-store.json" && ((x.scenarios?.length ?? 0) !== 0 || (x.drafts?.length ?? 0) !== 0 || x.runtime?.scenarioId || x.runtime?.runtimeId))
          throw Error("SIM_USER_LEGACY_RESET_REQUIRED");
        if (name === "publisher-queue.json" && (x.items?.length ?? 0) !== 0) throw Error("SIM_USER_LEGACY_RESET_REQUIRED");
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const pool = new pg.Pool({ connectionString: s.databaseUrl, max: 8, connectionTimeoutMillis: 1500 });
  attachSimPgErrorObservers(pool, "target");
  const continuity = await loadSimUserAuthority({
    Pool: pg.Pool,
    targetPool: pool,
    targetDatabaseUrl: s.databaseUrl,
    component: "sim_user_data",
    settings: s,
    identity: { ownerSecret: s.ownerSecret, actorSecret: s.actorSecret, routerActorSecret: s.routerActorSecret, issuer: s.issuer }
  });
  const ledger = new UserLedger(pool, s, "sim_user_data", continuity?.authority),
    leaves = new Map<string, { app: express.Express; context: AppContext }>();
  const includeCompleted = completedReplayEnabled(process.env.SIM_USER_DATA_COMPLETED_REPLAY_MODE);
  const root = join(s.root, s.resetEpoch);
  await mkdir(root, { recursive: true, mode: 0o700 });
  async function directory(owner: string, required = false) {
    if (!/^[a-f0-9]{64}$/.test(owner)) throw Error("SIM_OWNER_INVALID");
    for (const p of [s.root, root]) {
      const st = await lstat(p);
      if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o700 || st.uid !== uid() || (await realpath(p)) !== p)
        throw Error("SIM_USER_DIRECTORY_UNSAFE");
    }
    const dir = join(root, owner);
    try {
      const st = await lstat(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o700 || st.uid !== uid() || (await realpath(dir)) !== dir)
        throw Error("SIM_USER_DIRECTORY_UNSAFE");
      return dir;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || required) throw e;
      return undefined;
    }
  }
  async function inspect(owner: string) {
    const dir = await directory(owner);
    if (!dir) return [] as string[];
    const names = await readdir(dir);
    if (names.length > 50) throw Error("SIM_USER_DIRECTORY_UNSAFE");
    for (const n of names) {
      if (!files.has(n) && !/^publisher-queue\.json\.[a-f0-9-]{36}\.tmp$/.test(n)) throw Error("SIM_USER_DIRECTORY_UNREVIEWED");
      const st = await lstat(join(dir, n));
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== uid() || (st.mode & 0o777) !== 0o600) throw Error("SIM_USER_FILE_UNSAFE");
    }
    return names;
  }
  function identity(req: Request) {
    const p = authenticatedCanonicalOwner(req);
    if (!p || p.issuer !== s.issuer || p.oidcIat <= s.tokensNotBefore || p.oidcIat > Math.floor(Date.now() / 1000)) throw Error("SIM_CANONICAL_OWNER_REQUIRED");
    return p;
  }
  const sign = (req: Request) => {
    const p = identity(req);
    return signSimOwner(s.routerActorSecret, { ownerKey: canonicalOwnerKey(s.ownerSecret, p), resetEpoch: s.resetEpoch, oidcIat: p.oidcIat });
  };
  const initialFiles: Record<string, string> = {
    "sim-store.json": JSON.stringify(
      {
        scenarios: [],
        drafts: [],
        runtime: { state: "STOPPED", generatedEvents: 0, publishedEvents: 0, queuedEvents: 0 },
        aiConfig: { providerMode: "mock", externalProviderAllowed: false }
      },
      null,
      2
    ),
    "publisher-queue.json": JSON.stringify({ items: [], publishingEnabled: true }),
    "sim-audit.jsonl": ""
  };
  const seal = (owner: string, a: any) =>
    JSON.stringify({
      contractVersion: "sim-user-owned-directory-v1",
      environmentId: s.environmentId,
      resetEpoch: s.resetEpoch,
      ownerKey: owner,
      initializationId: a.initialization_id
    });
  async function validateSeal(owner: string, a: any) {
    const dir = await directory(owner, true);
    if ((await readFile(join(dir!, ".owner-scope.json"), "utf8")) !== seal(owner, a)) throw Error("SIM_USER_DIRECTORY_BINDING_MISMATCH");
  }
  async function initialize(owner: string) {
    // Commit ownership/nonce BEFORE mkdir. Business dispatch starts only after
    // the separate initialized=true transaction commits successfully.
    await ledger.withOwner(owner, async () => {});
    await ledger.withOwner(owner, async (c, a) => {
      const names = await inspect(owner);
      let dir = await directory(owner);
      if (a.initialized) {
        if (!dir) throw Error("SIM_USER_USED_STORAGE_MISSING");
        await validateSeal(owner, a);
        for (const name of Object.keys(initialFiles)) if (!names.includes(name)) throw Error("SIM_USER_USED_STORAGE_MISSING");
        return;
      }
      if (!dir) {
        dir = join(root, owner);
        await mkdir(dir, { mode: 0o700 });
      }
      const marker = join(dir, ".owner-scope.json");
      if (names.includes(".owner-scope.json")) await validateSeal(owner, a);
      else {
        if (names.length) throw Error("SIM_USER_UNPROVEN_PARTIAL_STORAGE");
        await writeFile(marker, seal(owner, a), { mode: 0o600, flag: "wx" });
      }
      for (const [name, value] of Object.entries(initialFiles)) {
        const p = join(dir, name);
        if (names.includes(name)) {
          if ((await readFile(p, "utf8")) !== value) throw Error("SIM_USER_UNPROVEN_PARTIAL_STORAGE");
        } else await writeFile(p, value, { mode: 0o600, flag: "wx" });
      }
      const fd = await open(dir, "r");
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }
      await c.query("UPDATE sim_user_data.account SET initialized=true WHERE owner_key=$1", [owner]);
    });
  }
  async function leaf(owner: string, _c: pg.PoolClient, a: any) {
    let found = leaves.get(owner);
    if (found) return found;
    const dir = await directory(owner, true);
    if (!a.initialized || !dir) throw Error("SIM_USER_USED_STORAGE_MISSING");
    await validateSeal(owner, a);
    const guard = async (work: () => Promise<void>) => {
      await ledger.withOwner(owner, async () => work(), { create: false });
    };
    found = await createApp(
      { ...config, dataDir: dir! },
      { guard, signAi: sign, userId: (req) => simOwnerAlias(canonicalOwnerKey(s.ownerSecret, identity(req))) }
    );
    leaves.set(owner, found);
    return found;
  }
  async function partner(path: string, headers: Record<string, string>, body?: unknown) {
    const r = await fetch(new URL("/api/v1/ai-router/internal/sim-user-history/v1" + path, s.routerUrl), {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(3000)
    });
    if (!r.body) throw Error("SIM_HISTORY_RESPONSE_UNPROVEN");
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    for await (const p of r.body) {
      bytes += p.length;
      if (bytes > 16384) throw Error("SIM_HISTORY_RESPONSE_UNPROVEN");
      chunks.push(p);
    }
    return { status: r.status, value: JSON.parse(Buffer.concat(chunks).toString("utf8")), cache: r.headers.get("cache-control") };
  }
  async function routerReady() {
    const r = await partner("/capabilities", { authorization: "Bearer " + s.routerToken });
    return (
      r.status === 200 &&
      r.cache === "no-store" &&
      r.value.contractVersion === SIM_USER_DATA_CONTRACT &&
      r.value.component === "sim_router_history" &&
      r.value.resetEpoch === s.resetEpoch &&
      r.value.scope === SIM_USER_SCOPE &&
      r.value.ready === true &&
      r.value.wholeAccountComplete === false
    );
  }
  async function routerCleanup(a: any, j: any, request = true) {
    const body = {
      contractVersion: SIM_USER_DATA_CONTRACT,
      scope: SIM_USER_SCOPE,
      resetEpoch: s.resetEpoch,
      operationId: j.operation_id,
      requestedAt: j.requested_at.toISOString()
    };
    const headers = {
      authorization: "Bearer " + s.routerToken,
      "content-type": "application/json",
      ...signSimOwner(s.routerActorSecret, {
        ownerKey: a.owner_key,
        resetEpoch: s.resetEpoch,
        oidcIat: Number(j.oidc_iat),
        operationId: j.operation_id,
        requestedAt: j.requested_at.toISOString()
      })
    };
    if (request) {
      const accepted = await partner("/deletions", headers, body);
      if (![200, 202].includes(accepted.status)) return false;
    }
    const r = await partner("/deletions/" + j.operation_id, headers);
    return (
      r.status === 200 &&
      r.cache === "no-store" &&
      r.value.contractVersion === SIM_USER_DATA_CONTRACT &&
      r.value.component === "sim_router_history" &&
      r.value.scope === SIM_USER_SCOPE &&
      r.value.resetEpoch === s.resetEpoch &&
      r.value.operationId === j.operation_id &&
      r.value.state === "deleted" &&
      r.value.remainingRecords === 0 &&
      r.value.wholeAccountComplete === false
    );
  }
  async function tick() {
    return ledger.runOne(async (_c, a, j) => {
      leaves.get(a.owner_key)?.context.runtimeRunner.dispose();
      leaves.delete(a.owner_key);
      // PG exclusive account lock drains every guarded HTTP, tick and audit write.
      const names = await inspect(a.owner_key),
        dir = await directory(a.owner_key);
      if (dir && names.length) await validateSeal(a.owner_key, a);
      if (dir) {
        // Keep the immutable ownership seal until every data file is gone.
        // A crash must leave either a verifiable partial delete or an empty dir.
        for (const n of names.filter((n) => n !== ".owner-scope.json")) await unlink(join(dir, n));
        if (names.includes(".owner-scope.json")) await unlink(join(dir, ".owner-scope.json"));
        if ((await readdir(dir)).length) throw Error("SIM_USER_DELETE_READBACK_FAILED");
        const fd = await open(dir, "r");
        try {
          await fd.sync();
        } finally {
          await fd.close();
        }
        await rmdir(dir);
        const parent = await open(root, "r");
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
      if ((await inspect(a.owner_key)).length !== 0) throw Error("SIM_USER_DELETE_READBACK_FAILED");
      if (!(await routerCleanup(a, j))) return { app_store: "deleted", audit_and_publisher: "deleted", router_sim_history: "pending" };
      return { app_store: "deleted", audit_and_publisher: "deleted", router_sim_history: "deleted" };
    }, { includeCompleted });
  }
  async function freshReceipt(value: any, owner: string) {
    if (value.state === "deleted") {
      if ((await inspect(owner)).length !== 0 || (await directory(owner))) throw Error("SIM_USER_DELETE_READBACK_FAILED");
      const j = await ledger.tx(async (c) => (await c.query("SELECT * FROM sim_user_data.job WHERE owner_key=$1", [owner])).rows[0]);
      if (!j || !(await routerCleanup({ owner_key: owner }, j, false))) throw Error("SIM_USER_HISTORY_UNPROVEN");
    }
    return value;
  }
  await ledger.tx(async (c) => {
    const r = (
      await c.query(
        "SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication AS elevated,has_schema_privilege(current_user,'public','CREATE') AS ddl FROM pg_roles r WHERE rolname=current_user"
      )
    ).rows[0];
    if (r.elevated || r.ddl) throw Error("SIM_USER_RUNTIME_NOT_RESTRICTED");
  });
  let stopped = false,
    running: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (!stopped && !running)
      running = tick()
        .catch(() => {})
        .finally(() => {
          running = undefined;
        });
  }, 1000);
  timer.unref();
  const app = express();
  app.use(cors(createCorsOptions(config)));
  app.use(PREFIX, express.json({ limit: "16kb" }));
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      await ledger.tx(async () => {});
      if (!(await routerReady())) throw Error("SIM_HISTORY_UNAVAILABLE");
      return res.json({ status: "ok" });
    } catch {
      return res.status(503).json({ status: "unavailable" });
    }
  });
  const auth = (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    if (req.headers.origin || req.originalUrl.includes("?")) {
      res.status(404).json({ error: "NOT_FOUND" });
      return null;
    }
    const token = /^Bearer (.+)$/.exec(req.header("authorization") ?? "")?.[1] ?? "";
    if (!equal(token, s.serviceToken)) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return null;
    }
    const actor = verifyCleanActor(req, {
      actorSecret: s.actorSecret,
      issuer: s.issuer,
      tokensNotBefore: s.tokensNotBefore,
      expected: { resetEpoch: s.resetEpoch }
    });
    if (!actor) {
      res.status(401).json({ error: "INVALID_ACTOR" });
      return null;
    }
    return actor;
  };
  app.get(PREFIX + "/capabilities", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!equal(req.header("authorization") ?? "", "Bearer " + s.serviceToken) || req.headers.origin || req.originalUrl.includes("?"))
      return res.status(401).json({ error: "UNAUTHORIZED" });
    try {
      await ledger.tx(async () => {});
      if (!(await routerReady())) throw Error("SIM_HISTORY_UNAVAILABLE");
      return res.json({
        contractVersion: SIM_USER_DATA_CONTRACT,
        component: "sim_user_data",
        scope: SIM_USER_SCOPE,
        resetEpoch: s.resetEpoch,
        ready: !stopped,
        wholeAccountComplete: false
      });
    } catch {
      return res.status(503).json({ error: "SIM_USER_DATA_UNAVAILABLE" });
    }
  });
  app.post(PREFIX + "/deletions", async (req, res) => {
    const a = auth(req, res);
    if (!a) return;
    const b = req.body;
    if (
      !b ||
      Object.keys(b).length !== 5 ||
      !["contractVersion", "scope", "resetEpoch", "operationId", "requestedAt"].every((k) => Object.hasOwn(b, k)) ||
      b.contractVersion !== SIM_USER_DATA_CONTRACT ||
      b.scope !== SIM_USER_SCOPE ||
      b.resetEpoch !== a.resetEpoch ||
      b.operationId !== a.operationId ||
      b.requestedAt !== a.requestedAt
    )
      return res.status(400).json({ error: "INVALID_REQUEST" });
    try {
      const owner = canonicalOwnerKey(s.ownerSecret, { issuer: a.oidcIssuer, subject: a.oidcSubject });
      const result = await ledger.request(owner, a.operationId, a.requestedAt, a.oidcIat);
      return res.status(result.state === "deleted" ? 200 : 202).json(await freshReceipt(result, owner));
    } catch (e) {
      return res.status((e as Error).message === "SIM_USER_OPERATION_CONFLICT" ? 409 : 503).json({ error: "SIM_USER_DATA_UNAVAILABLE" });
    }
  });
  app.get(PREFIX + "/deletions/:operationId", async (req, res) => {
    const a = auth(req, res);
    if (!a) return;
    if (req.params.operationId !== a.operationId) return res.status(400).json({ error: "INVALID_OPERATION" });
    try {
      const owner = canonicalOwnerKey(s.ownerSecret, { issuer: a.oidcIssuer, subject: a.oidcSubject }),
        r = await ledger.status(owner, a.operationId);
      return r ? res.json(await freshReceipt(r, owner)) : res.status(404).json({ error: "NOT_FOUND" });
    } catch {
      return res.status(503).json({ error: "SIM_USER_DATA_UNAVAILABLE" });
    }
  });
  app.use(PREFIX, (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(404).json({ error: "NOT_FOUND" });
  });
  app.use(createSecurityMiddleware(config, new AnonymousAuthAudit(root)));
  app.use(async (req, res) => {
    try {
      const p = identity(req),
        key = canonicalOwnerKey(s.ownerSecret, p);
      await initialize(key);
      await ledger.withOwner(
        key,
        async (c, a) => {
          const target = await leaf(key, c, a);
          await new Promise<void>((resolve, reject) => {
            res.once("finish", resolve);
            res.once("close", resolve);
            target.app(req, res, (e?: unknown) => (e ? reject(e) : resolve()));
          });
        },
        { create: false }
      );
    } catch (e) {
      if (process.env.SIM_USER_DATA_DIAGNOSTICS === "true") {
        const x = e as { message?: string; code?: string };
        console.error(
          JSON.stringify({
            event: "sim_user_data_rejected",
            code: /^SIM_[A-Z_]+$/.test(x.message ?? "") ? x.message : /^[0-9A-Z]{5}$/.test(x.code ?? "") ? x.code : "UNCLASSIFIED"
          })
        );
      }
      if (!res.headersSent) res.status(503).json({ error: "SIM_USER_DATA_UNAVAILABLE" });
      else res.end();
    }
  });
  return {
    app,
    ledger,
    tick,
    pool,
    async close() {
      stopped = true;
      clearInterval(timer);
      await running;
      for (const l of leaves.values()) l.context.runtimeRunner.dispose();
      leaves.clear();
      await pool.end();
      await continuity?.close();
    }
  };
}
