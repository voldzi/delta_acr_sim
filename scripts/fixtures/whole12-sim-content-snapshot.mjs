/** Fixed isolated TLSv2 content snapshot. READ ONLY SQL; writes only RAM file.
 * No restore implementation, trigger bypass, guard DB or journal snapshot.
 * Not a production backup/operator and not whole-account acceptance evidence. */
import { constants } from "node:fs";
import { open, lstat, readdir } from "node:fs/promises";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
const ROOT = "/private/tmp/sim-user-install-pg-9aff26e65b74";
const PRIVATE = "/dev/shm/cop-clean-whole/sim-private.json";
const OUTPUT = "/dev/shm/cop-clean-whole/sim-content-snapshot.json";
const need = (v, code = "SIM_CONTENT_SNAPSHOT_REFUSED") => {
  if (!v) throw Error(code);
};
const stable = (x) =>
  Array.isArray(x)
    ? x.map(stable)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, stable(x[k])])
        )
      : x;
const digest = (x) =>
  createHash("sha256")
    .update(JSON.stringify(stable(x)))
    .digest("hex");
async function privateFile(path, limit = 32768000) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await f.stat();
    need(s.isFile() && s.nlink === 1 && s.uid === process.getuid() && (s.mode & 0o777) === 0o600 && s.size <= limit);
    const bytes = await f.readFile(),
      a = await f.stat();
    need(bytes.length === s.size && s.ino === a.ino && s.mtimeMs === a.mtimeMs && s.ctimeMs === a.ctimeMs);
    return bytes;
  } finally {
    await f.close();
  }
}
/** Public receipt only; target content stays in the fixed private RAM output. */
export async function captureWhole12SimContent() {
  const root = await lstat(ROOT);
  need(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid() && (root.mode & 0o777) === 0o700);
  const raw = await privateFile(PRIVATE, 131072),
    cfg = JSON.parse(raw),
    b = cfg.input.base,
    u = cfg.input.userDataEnvironment;
  need(cfg.input.contractVersion === "cop-sim-clean-whole-fixture-v2" && b.issuer === "https://cop-erasure-keycloak.invalid/realms/cop");
  const { canonicalOwnerKey, simOwnerAlias } = await import("/app/packages/sim-user-data/claims.mjs");
  const { Pool } = createRequire("/runtime/router/apps/ai-router-api/package.json")("pg");
  const pools = Object.fromEntries(
    ["sim_ai_router", "sim_driver_measurements", "sim_user_data"].map((database) => {
      const p = new Pool({ host: ROOT + "/s", port: 5000, user: "fixture_admin", database, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 7000 });
      p.on("error", () => {});
      return [database, p];
    })
  );
  const hashes = Object.fromEntries(
    Object.entries(b.actors).map(([name, a]) => {
      const owner = canonicalOwnerKey(u.ownerSecret, { issuer: b.issuer, subject: a.subjectId });
      const hash = (client, id) =>
        createHash("sha256").update(b.environment.routerHashSecret).update("\0").update(client).update("\0").update(id).digest("hex");
      return [
        name,
        {
          owner,
          cop: hash("cop", a.routerUserId),
          sim: hash("sim", simOwnerAlias(owner)),
          izs: hash("izs", simOwnerAlias(owner)),
          driver: createHmac("sha256", b.environment.driverHashSecret)
            .update("cop:" + a.contributorIdDay)
            .digest("hex"),
          aiOwner: createHmac("sha256", b.environment.routerActorSecret)
            .update("sim-clean-owner-v1\0" + b.issuer + "\0" + a.subjectId)
            .digest("hex"),
          driverOwner: createHmac("sha256", b.environment.driverActorSecret)
            .update("sim-clean-owner-v1\0" + b.issuer + "\0" + a.subjectId)
            .digest("hex")
        }
      ];
    })
  );
  async function rows(c, table, where, params) {
    // All table/where strings originate from the finite literals below.
    const r = (await c.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${where} ORDER BY to_jsonb(t)::text LIMIT 10001`, params)).rows;
    need(r.length <= 10000, "SIM_CONTENT_SNAPSHOT_LIMIT");
    return r.map((x) => x.row);
  }
  async function files(h, c) {
    const account = (
      await c.query("SELECT state,initialized,initialization_id FROM sim_user_data.account WHERE owner_key=$1 AND reset_epoch=$2", [h.owner, b.resetEpoch])
    ).rows;
    need(account.length === 1 && account[0].state === "active" && account[0].initialized, "SIM_CONTENT_SNAPSHOT_NOT_PREDELETE");
    const dir = join(ROOT, "data/main/sim-user-data-v1", b.resetEpoch, h.owner),
      ds = await lstat(dir);
    need(ds.isDirectory() && !ds.isSymbolicLink() && ds.uid === process.getuid() && (ds.mode & 0o777) === 0o700);
    const names = (await readdir(dir)).sort();
    need(JSON.stringify(names) === JSON.stringify([".owner-scope.json", "publisher-queue.json", "sim-audit.jsonl", "sim-store.json"]));
    const out = {};
    for (const name of names) {
      const path = join(dir, name),
        f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const s = await f.stat();
        need(s.isFile() && s.nlink === 1 && s.uid === process.getuid() && s.size <= 4194304);
        const bytes = await f.readFile(),
          after = await f.stat();
        need(bytes.length === s.size && s.ino === after.ino && s.mtimeMs === after.mtimeMs && s.ctimeMs === after.ctimeMs);
        out[name] = { bytes: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), mode: s.mode & 0o777, uid: s.uid, gid: s.gid };
      } finally {
        await f.close();
      }
    }
    const marker = JSON.parse(Buffer.from(out[".owner-scope.json"].bytes, "base64").toString("utf8"));
    need(
      marker.ownerKey === h.owner && marker.resetEpoch === b.resetEpoch && marker.initializationId === account[0].initialization_id,
      "SIM_CONTENT_SNAPSHOT_SEAL_MISMATCH"
    );
    return out;
  }
  async function take() {
    const clients = {};
    try {
      for (const [db, pool] of Object.entries(pools)) {
        const c = await pool.connect();
        clients[db] = c;
        await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const r = (
          await c.query(
            "SELECT current_user u,current_database() d,current_setting('data_directory') dir,current_setting('cluster_name') cluster,current_setting('ssl') ssl,current_setting('listen_addresses') listen,current_setting('port') port,inet_server_addr() address"
          )
        ).rows[0];
        need(
          r.u === "fixture_admin" &&
            r.d === db &&
            r.dir === ROOT + "/db" &&
            r.cluster === "sim_whole12_tls_fixture_v1" &&
            r.ssl === "on" &&
            r.listen === "127.0.0.1" &&
            r.port === "5000" &&
            r.address === null,
          "SIM_CONTENT_SNAPSHOT_NOT_OWNED_PG"
        );
      }
      const ai = clients.sim_ai_router,
        driver = clients.sim_driver_measurements,
        app = clients.sim_user_data;
      for (const [c, schema, owners] of [
        [ai, "sim_clean", Object.values(hashes).map((x) => x.aiOwner)],
        [driver, "sim_clean", Object.values(hashes).map((x) => x.driverOwner)],
        [ai, "sim_user_history", Object.values(hashes).map((x) => x.owner)],
        [app, "sim_user_data", Object.values(hashes).map((x) => x.owner)]
      ]) {
        const accounts = (await c.query(`SELECT state FROM ${schema}.account WHERE owner_key=ANY($1::text[])`, [owners])).rows;
        need(accounts.length === 2 && accounts.every((x) => x.state === "active"), "SIM_CONTENT_SNAPSHOT_NOT_PREDELETE");
        need(
          Number((await c.query(`SELECT count(*) n FROM ${schema}.job WHERE owner_key=ANY($1::text[])`, [owners])).rows[0].n) === 0,
          "SIM_CONTENT_SNAPSHOT_ALREADY_ACCEPTED"
        );
      }
      const scopes = { sim_measurements: {}, ai_router: {}, sim_user_data: {} };
      for (const [name, h] of Object.entries(hashes)) {
        scopes.sim_measurements[name] = {
          tables: {
            driver_measurement_receipts: await rows(driver, "public.driver_measurement_receipts", "t.owner='cop' AND t.contributor_hash=$1", [h.driver]),
            driver_measurement_intervals: await rows(
              driver,
              "public.driver_measurement_intervals",
              "t.owner='cop' AND EXISTS(SELECT FROM public.driver_measurement_receipts r WHERE r.owner=t.owner AND r.batch_id=t.batch_id AND r.contributor_hash=$1)",
              [h.driver]
            ),
            driver_measurement_eta: await rows(driver, "public.driver_measurement_eta", "t.owner='cop' AND t.contributor_hash=$1", [h.driver]),
            driver_measurement_revocations: await rows(driver, "public.driver_measurement_revocations", "t.owner='cop' AND t.contributor_hash=$1", [h.driver])
          }
        };
        scopes.ai_router[name] = {
          tables: {
            ai_router_user_key: await rows(ai, "public.ai_router_user_key", "t.user_hash=$1", [h.cop]),
            ai_router_user_key_audit: await rows(ai, "public.ai_router_user_key_audit", "t.user_hash=$1", [h.cop]),
            ai_router_request: await rows(ai, "public.ai_router_request", "t.client_id='cop' AND t.user_hash=$1", [h.cop]),
            ai_router_billing_request: await rows(ai, "public.ai_router_billing_request", "t.task_type='cop_chat' AND t.actor_hash=$1", [h.cop])
          }
        };
        scopes.sim_user_data[name] = {
          tables: {
            ai_router_request: await rows(ai, "public.ai_router_request", "t.client_id='sim' AND t.user_hash=$1", [h.sim]),
            ai_router_billing_request: await rows(
              ai,
              "public.ai_router_billing_request",
              "t.task_type='sim_izs_summary' AND t.billing_source='sim_project' AND t.payer_hash='sim_izs_project' AND t.actor_hash=$1",
              [h.izs]
            )
          },
          files: await files(h, app)
        };
      }
      const witness = {};
      for (const [db, schema] of [
        ["sim_ai_router", "sim_user_history"],
        ["sim_user_data", "sim_user_data"]
      ]) {
        const c = clients[db],
          r = (await c.query(`SELECT to_jsonb(t) AS row FROM ${schema}.continuity t WHERE singleton`)).rows;
        need(r.length === 1 && r[0].row.reset_epoch === b.resetEpoch && r[0].row.environment_id === b.environmentId);
        for (const [k, v] of Object.entries(cfg.bindings[schema])) need(String(r[0].row[k]) === String(v));
        witness[schema] = digest(r[0].row);
      }
      return { scopes, witness };
    } finally {
      for (const c of Object.values(clients)) {
        try {
          await c.query("ROLLBACK");
        } finally {
          c.release();
        }
      }
    }
  }
  try {
    const content = await take(),
      again = await take();
    need(digest(content) === digest(again), "SIM_CONTENT_SNAPSHOT_CHANGED");
    need((await privateFile(PRIVATE, 131072)).equals(raw), "SIM_CONTENT_SNAPSHOT_PRIVATE_CHANGED");
    const counts = Object.fromEntries(
      Object.entries(content.scopes).map(([owner, actors]) => [
        owner,
        Object.fromEntries(Object.entries(actors).map(([name, a]) => [name, Object.values(a.tables).reduce((n, rows) => n + rows.length, 0)]))
      ])
    );
    need(
      Object.values(counts).every((x) => x.a > 0 && x.b > 0),
      "SIM_CONTENT_SNAPSHOT_EMPTY_SCOPE"
    );
    const payload = {
      contractVersion: "sim-whole12-content-snapshot-v1",
      snapshotId: randomUUID(),
      resetEpoch: b.resetEpoch,
      privateBindingDigest: digest(cfg),
      capturedAt: new Date().toISOString(),
      ...content
    };
    const bytes = Buffer.from(JSON.stringify(payload));
    need(bytes.length <= 32768000, "SIM_CONTENT_SNAPSHOT_LIMIT");
    const out = await open(OUTPUT, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await out.writeFile(bytes);
      await out.sync();
    } finally {
      await out.close();
    }
    return {
      contractVersion: "sim-whole12-content-snapshot-receipt-v1",
      snapshotId: payload.snapshotId,
      resetEpoch: b.resetEpoch,
      snapshotSha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      capturedRows: counts,
      mainFiles: { a: 4, b: 4 },
      independentGuardOrJournalsIncluded: false,
      targetControlJournalsIncluded: false,
      restoredRows: null,
      restoresPerformed: 0,
      deletionsPerformed: 0,
      wholeAccountComplete: false
    };
  } finally {
    for (const p of Object.values(pools)) await p.end();
  }
}
export async function restoreAndReplayWhole12SimContent() {
  throw Error("SIM_COMPLETED_RESTORE_TRANSITION_NOT_IMPLEMENTED");
}
