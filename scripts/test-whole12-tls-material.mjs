/** Actual synthetic certificate handshakes only; NOT PostgreSQL/bootstrap GO. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import tls from "node:tls";
import { prepareWhole12Tls } from "./fixtures/whole12-tls-material.mjs";
assert.deepEqual(process.argv.slice(2), ["--run"]);
const umask = process.umask(0o077),
  root = await mkdtemp("/private/tmp/sim-user-install-pg-");
let server,
  passed = false;
try {
  const x = await prepareWhole12Tls(root);
  server = tls.createServer({ key: await readFile(join(root, "tls/server.key")), cert: await readFile(join(root, "tls/server.pem")) }, (s) => s.end());
  server.on("tlsClientError", () => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const handshake = (ca, servername) =>
    new Promise((r, j) => {
      const s = tls.connect({ host: "127.0.0.1", port: server.address().port, ca, servername, rejectUnauthorized: true }, () => {
        const result = s.authorized;
        s.destroy();
        r(result);
      });
      s.once("error", j);
    });
  assert.equal(await handshake(x.ca, "haproxy.home.cz"), true);
  await assert.rejects(() => handshake(x.wrongCa, "haproxy.home.cz"));
  await assert.rejects(() => handshake(x.ca, "wrong.invalid"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  assert.equal(x.postgres.port, 5000);
  assert.equal(x.clientReadOnlyMounts[1].target, "/etc/csm-sim/postgresql-ca.pem");
  await assert.rejects(() => prepareWhole12Tls(root), { code: "EEXIST" });
  console.log(
    JSON.stringify({ checks: 6, actualSyntheticTlsHandshakes: true, actualPostgresBootstrap: false, productionWrites: 0, wholeAccountComplete: false })
  );
  passed = true;
} finally {
  if (server) await new Promise((r) => server.close(r));
  if (passed) await rm(root, { recursive: true, force: true });
  process.umask(umask);
}
