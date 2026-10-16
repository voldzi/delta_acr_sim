import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { createSecureContext, TLSSocket } from "node:tls";
import { postgresTlsPreflight } from "./postgres-client-preflight.mjs";
const root = mkdtempSync("/private/tmp/sim-postgres-tls-preflight-");
const makeCert = (name) => {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-days",
      "1",
      "-keyout",
      root + "/" + name + ".key",
      "-out",
      root + "/" + name + ".crt"
    ],
    { stdio: "pipe", timeout: 10000 }
  );
  return { key: readFileSync(root + "/" + name + ".key"), cert: readFileSync(root + "/" + name + ".crt") };
};
const first = makeCert("first"),
  other = makeCert("other");
async function fixture(mode, work) {
  const sockets = new Set(),
    observed = { sslRequests: 0, authOrSqlBytes: 0 };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (request) => {
      assert.equal(request.length, 8);
      assert.equal(request.readUInt32BE(0), 8);
      assert.equal(request.readUInt32BE(4), 80877103);
      observed.sslRequests++;
      if (mode === "timeout") return;
      if (mode === "reject") {
        socket.end("N");
        return;
      }
      socket.write("S");
      const secure = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext(first) });
      sockets.add(secure);
      secure.on("error", () => {});
      secure.on("close", () => sockets.delete(secure));
      secure.on("data", (bytes) => {
        observed.authOrSqlBytes += bytes.length;
      });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await work(server.address().port, observed);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  }
}
try {
  await test("actual SSLRequest and verified TLS require no password, login or SQL", () =>
    fixture("tls", async (port, observed) => {
      const result = await postgresTlsPreflight({ host: "127.0.0.1", port, serverName: "localhost", ca: first.cert, timeoutMs: 1500 });
      assert.deepEqual(result, { tlsVerified: true, credentialUsed: false, databaseLoginChecked: false, sqlExecuted: false });
      assert.equal(observed.sslRequests, 1);
      assert.equal(observed.authOrSqlBytes, 0);
    }));
  await test("untrusted certificate refuses and never falls back to plaintext", () =>
    fixture("tls", async (port) => {
      await assert.rejects(
        postgresTlsPreflight({ host: "127.0.0.1", port, serverName: "localhost", ca: other.cert, timeoutMs: 1500 }),
        /POSTGRES_TRANSPORT_PREFLIGHT_TLS_CERTIFICATE_REJECTED/
      );
    }));
  await test("hostname mismatch refuses", () =>
    fixture("tls", async (port) => {
      await assert.rejects(
        postgresTlsPreflight({ host: "127.0.0.1", port, serverName: "wrong.example.invalid", ca: first.cert, timeoutMs: 1500 }),
        /POSTGRES_TRANSPORT_PREFLIGHT_TLS_CERTIFICATE_REJECTED/
      );
    }));
  await test("server plaintext-only response refuses before authentication", () =>
    fixture("reject", async (port, observed) => {
      await assert.rejects(
        postgresTlsPreflight({ host: "127.0.0.1", port, serverName: "localhost", ca: first.cert, timeoutMs: 1500 }),
        /POSTGRES_TRANSPORT_PREFLIGHT_TLS_REQUIRED/
      );
      assert.equal(observed.authOrSqlBytes, 0);
    }));
  await test("stalled server has a bounded timeout and closes its socket", () =>
    fixture("timeout", async (port) => {
      await assert.rejects(
        postgresTlsPreflight({ host: "127.0.0.1", port, serverName: "localhost", ca: first.cert, timeoutMs: 80 }),
        /POSTGRES_TRANSPORT_PREFLIGHT_CONNECTION_TIMEOUT/
      );
    }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
