/** Actual isolated HTTP/SQL companion. Does not mint JWTs, simulate Root,
 * certify Keycloak, attach production continuity, or produce acceptance GO. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { FIXTURE_ISSUER, makeCleanWholeInput, provisionCleanWhole, startCleanWholeComponent, seedCleanWhole, readCleanWhole } from "./clean-whole-sim-v1.mjs";
import { makeCleanWholeAppInput, provisionCleanWholeApp, startCleanWholeApp, historySettings } from "./clean-whole-sim-user-data-v2.mjs";
import { canonicalOwnerKey, simOwnerAlias } from "../../packages/sim-user-data/claims.mjs";

/** Private tmpfs/file input only. Contents never enter argv, Docker env or logs. */
export async function readPrivateCompanionInput(path) {
  assert.ok(path.startsWith("/private/tmp/") || path.startsWith("/dev/shm/"));
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    assert.ok(s.isFile() && s.nlink === 1 && s.uid === process.getuid() && (s.mode & 0o777) === 0o600 && s.size <= 131072);
    const raw = await h.readFile();
    const after = await h.stat();
    assert.equal(raw.length, s.size);
    assert.equal(after.mtimeMs, s.mtimeMs);
    assert.equal(after.ctimeMs, s.ctimeMs);
    return JSON.parse(raw.toString("utf8"));
  } finally {
    await h.close();
  }
}

export function validateCompanionActors(A, B, issuer, jwksOrigin) {
  assert.equal(issuer, FIXTURE_ISSUER, "NEW_FIXTURE_ISSUER_NOT_ENROLLED");
  const url = new URL(jwksOrigin);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.username + url.password + url.search + url.hash, "");
  assert.equal(url.pathname, "/realms/cop/protocol/openid-connect/certs");
  for (const actor of [A, B]) {
    assert.equal(typeof actor.jwt, "string");
    const claims = JSON.parse(Buffer.from(actor.jwt.split(".")[1], "base64url").toString("utf8"));
    // Only preflight shape. Actual compiled main middleware verifies signature,
    // issuer, audience and roles using the real supplied KC JWKS endpoint.
    assert.equal(claims.iss, issuer);
    assert.equal(claims.sub, actor.subjectId);
    assert.equal(claims.iat, actor.oidcIat);
    assert.ok(claims.realm_access.roles.includes("SIM_ADMIN"));
  }
}

/** db must be the actual owned factory object; provision rejects other clusters.
 * A/B: {subjectId,routerUserId,contributorIdDay,oidcIat,jwt} from actual KC.
 * Fixed isolated ports only, no public listener, no external-provider calls. */
export function createWhole12SimCompanion(db) {
  let input, ai, driver, main, server, readback;
  const response = JSON.stringify({
    name: "Synthetic flood fixture",
    description: "Fictional civil fixture for two synthetic accounts.",
    durationSeconds: 60,
    objectCount: 1
  });
  const listen = (app) =>
    new Promise((resolve, reject) => {
      const s = createServer(app);
      s.once("error", reject);
      s.listen(4314, "127.0.0.1", () => resolve(s));
    });
  const stop = async (lane) => {
    if (lane === "main") {
      if (server) await new Promise((r, j) => server.close((e) => (e ? j(e) : r())));
      server = undefined;
      await main?.close();
      main = undefined;
    } else if (lane === "ai") {
      await ai?.close();
      ai = undefined;
    } else if (lane === "driver") {
      await driver?.close();
      driver = undefined;
    } else throw Error("UNKNOWN_COMPANION_COMPONENT");
  };
  async function resume(lane, jwks) {
    if (lane === "ai") {
      assert.ok(!ai);
      ai = await startCleanWholeComponent(db, input.base, "ai", { simHistorySettings: historySettings(input), syntheticModelResponse: response });
    } else if (lane === "driver") {
      assert.ok(!driver);
      driver = await startCleanWholeComponent(db, input.base, "driver");
    } else if (lane === "main") {
      assert.ok(!main && ai);
      main = await startCleanWholeApp(db, input, { jwksUri: jwks, routerUrl: ai.api });
      server = await listen(main.app);
    } else throw Error("UNKNOWN_COMPANION_COMPONENT");
  }
  let jwks;
  const api = {
    async seed(A, B, issuer, jwksOrigin) {
      assert.ok(!input, "COMPANION_SEED_ONCE");
      validateCompanionActors(A, B, issuer, jwksOrigin);
      const strip = ({ jwt, ...identity }) => identity;
      input = makeCleanWholeAppInput(makeCleanWholeInput({ actors: { a: strip(A), b: strip(B) } }));
      jwks = jwksOrigin;
      await provisionCleanWhole(db, input.base);
      await provisionCleanWholeApp(db, input);
      await resume("ai");
      await resume("driver");
      await resume("main", jwks);
      await seedCleanWhole(ai);
      await seedCleanWhole(driver);
      for (const actor of [A, B]) {
        const send = async (path, body) => {
          const r = await fetch("http://127.0.0.1:4314" + path, {
            method: "POST",
            headers: { authorization: "Bearer " + actor.jwt, "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(7000)
          });
          assert.equal(r.status, 201, "ACTUAL_MAIN_KC_AUTHENTICATED_SEED");
          return r.json();
        };
        await send("/api/v1/scenarios", {
          name: "Synthetic private fixture",
          description: "Fictional civil exercise only",
          area: { type: "BBOX", bbox: [14, 49.8, 15, 50.3] },
          durationSeconds: 60,
          seed: 17,
          blocks: [{ blockId: "rescue-sim", enabled: true, objectCount: 1, updateRateHz: 1 }],
          faults: []
        });
        await send("/api/v1/ai/router-scenario-drafts", { prompt: "Fictional civil flood exercise only", syntheticOnly: true });
      }
      // Returned object is PRIVATE RAM configuration for the COP adapter.
      // Caller must not log, serialize publicly, or put it in Docker env.
      readback = createServer(async (q, r) => {
        r.setHeader("cache-control", "no-store");
        r.setHeader("content-type", "application/json");
        const deny = (s, error) => {
          r.writeHead(s);
          r.end(JSON.stringify({ error }));
        };
        if (q.method !== "GET" || q.url !== "/readback" || q.headers.origin) return deny(404, "NOT_FOUND");
        const got = Buffer.from(q.headers.authorization ?? ""),
          want = Buffer.from("Bearer " + input.base.environment.copServiceToken);
        if (got.length !== want.length || !timingSafeEqual(got, want)) return deny(401, "UNAUTHORIZED");
        try {
          r.end(JSON.stringify(await api.read()));
        } catch {
          deny(503, "COMPANION_READBACK_UNAVAILABLE");
        }
      });
      await new Promise((resolve, reject) => {
        readback.once("error", reject);
        readback.listen(4324, "127.0.0.1", resolve);
      });
      return {
        input,
        endpoints: { main: "http://127.0.0.1:4314", ai: ai.api, driver: driver.api, readback: "http://127.0.0.1:4324/readback" },
        limitations: { productionContinuityAttached: false, realKeycloakProof: "caller-must-verify", wholeAccountComplete: false }
      };
    },
    async read() {
      assert.ok(main && ai && driver);
      const history = {};
      for (const name of ["a", "b"]) {
        const owner = canonicalOwnerKey(input.userDataEnvironment.ownerSecret, { issuer: input.base.issuer, subject: input.base.actors[name].subjectId });
        const hash = ai.store.hashUser("sim", simOwnerAlias(owner));
        const rows = (await ai.runtime.query("SELECT to_jsonb(r) AS row FROM ai_router_request r WHERE client_id='sim' AND user_hash=$1 ORDER BY id", [hash]))
          .rows;
        const izs = ai.store.hashUser("izs", simOwnerAlias(owner));
        const billing = (
          await ai.runtime.query("SELECT to_jsonb(r) AS row FROM ai_router_billing_request r WHERE task_type='sim_izs_summary' AND actor_hash=$1 ORDER BY id", [
            izs
          ])
        ).rows;
        const state = (await ai.runtime.query("SELECT state FROM sim_user_history.account WHERE owner_key=$1", [owner])).rows[0]?.state ?? "unused";
        history[name] = {
          requests: rows.length,
          billing: billing.length,
          state,
          fingerprint: createHash("sha256").update(JSON.stringify({ rows, billing })).digest("hex")
        };
      }
      return {
        app: await main.read(),
        ai: await readCleanWhole(ai),
        driver: await readCleanWhole(driver),
        simHistory: history,
        productionContinuityAttached: false,
        wholeAccountComplete: false
      };
    },
    outage: stop,
    async recover(lane) {
      assert.ok(input);
      await resume(lane, jwks);
    },
    async close() {
      if (readback) await new Promise((r) => readback.close(r));
      readback = undefined;
      await stop("main");
      await stop("driver");
      await stop("ai");
    }
  };
  return api;
}
