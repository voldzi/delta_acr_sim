/** Fixed internal transport, not a configurable/open proxy. Main verifies the
 * distinct service token and actor signature; this relay adds no authority. */
import express, { type Express } from "express";
export function registerSimUserDataRelay(app: Express, fixture?: { owner: "cop-sim-clean-whole-20261017"; target: "http://127.0.0.1:4314" }) {
  if (process.env.SIM_USER_DATA_RELAY_ENABLED !== "true" && !fixture) return;
  const target = fixture ? fixture.target : "http://sim-api:4000";
  if (fixture && (process.env.NODE_ENV !== "test" || fixture.owner !== "cop-sim-clean-whole-20261017" || target !== "http://127.0.0.1:4314"))
    throw Error("SIM_USER_RELAY_FIXTURE_UNPROVEN");
  const prefix = "/api/v1/internal/sim-user-data/v1";
  app.use(prefix, express.json({ limit: "16kb" }));
  app.use(prefix, (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.set("Cache-Control", "no-store");
    res.status(413).json({ error: "INVALID_PAYLOAD" });
  });
  app.use(prefix, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const path = req.originalUrl;
    if (
      req.headers.origin ||
      path.includes("?") ||
      !(
        (req.method === "GET" && (path === prefix + "/capabilities" || new RegExp("^" + prefix + "/deletions/[a-f0-9-]{36}$").test(path))) ||
        (req.method === "POST" && path === prefix + "/deletions")
      )
    )
      return res.status(404).json({ error: "NOT_FOUND" });
    const headers: Record<string, string> = {};
    for (const key of ["authorization", "content-type", "x-cop-clean-actor", "x-cop-clean-actor-signature"]) {
      const v = req.header(key);
      if (v) {
        if (v.length > 4096) return res.status(400).json({ error: "INVALID_HEADER" });
        headers[key] = v;
      }
    }
    const body = req.method === "POST" ? JSON.stringify(req.body ?? null) : undefined;
    if (body && Buffer.byteLength(body) > 16384) return res.status(413).json({ error: "PAYLOAD_TOO_LARGE" });
    try {
      const r = await fetch(target + path, { method: req.method, headers, body, redirect: "error", signal: AbortSignal.timeout(3500) });
      if (!r.body) throw Error("EMPTY");
      const parts: Uint8Array[] = [];
      let bytes = 0;
      for await (const p of r.body) {
        bytes += p.length;
        if (bytes > 16384) throw Error("BOUND");
        parts.push(p);
      }
      const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
      return res.status(r.status).json(value);
    } catch {
      return res.status(503).json({ error: "SIM_USER_DATA_UNAVAILABLE" });
    }
  });
}
