/** Credential-free client/TLS preflight and bounded error categories only.
 * Never print libpq stderr, connection strings, SQL, passwords or exception text. */
import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const SQLSTATES = new Set([
  "08001",
  "08006",
  "0A000",
  "22023",
  "22P02",
  "23502",
  "23503",
  "23505",
  "23514",
  "25P02",
  "28000",
  "28P01",
  "3D000",
  "40001",
  "40P01",
  "42501",
  "42601",
  "42703",
  "42704",
  "42710",
  "42P01",
  "42P07",
  "53300",
  "53400",
  "55P03",
  "57014",
  "57P01"
]);
export function classifyPostgresFailure(error) {
  if (error?.code === "ENOENT") return "CLIENT_MISSING";
  if (error?.code === "EACCES" || error?.code === "EPERM") return "CLIENT_PERMISSION";
  if (error?.code === "ETIMEDOUT") return "CLIENT_TIMEOUT";
  if (error?.signal) return "CLIENT_INTERRUPTED";
  // Inspect only a bounded buffer and return constants, never matched substrings.
  const stderr = String(error?.stderr ?? "").slice(0, 16384);
  if (/You must install at least one postgresql-client-[^\r\n]*package/i.test(stderr)) return "CLIENT_NOT_INSTALLED";
  if (/password authentication failed/i.test(stderr)) return "AUTH_FAILED";
  if (/no pg_hba\.conf entry|pg_hba\.conf rejects connection/i.test(stderr)) return "AUTH_POLICY";
  if (/root certificate file|could not read.*certificate|could not load.*certificate/i.test(stderr)) return "TLS_CA_UNREADABLE";
  if (/certificate verify failed|does not match host name|server certificate.*does not match|SSL error/i.test(stderr)) return "TLS_CERTIFICATE_REJECTED";
  if (/could not translate host name|Name or service not known|Temporary failure in name resolution/i.test(stderr)) return "DNS_FAILED";
  if (/Connection refused/i.test(stderr)) return "CONNECTION_REFUSED";
  if (/timeout expired|Connection timed out/i.test(stderr)) return "CONNECTION_TIMEOUT";
  const state = /(?:ERROR|FATAL):\s*([A-Z0-9]{5})\b/.exec(stderr)?.[1];
  return state && SQLSTATES.has(state) ? "SQLSTATE_" + state : "UNKNOWN";
}
export function verifyPostgresClient(psql = "/usr/lib/postgresql/18/bin/psql") {
  let output;
  try {
    output = execFileSync(psql, ["--version"], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      maxBuffer: 16384
    });
  } catch (error) {
    throw Error("POSTGRES_CLIENT_PREFLIGHT_" + classifyPostgresFailure(error));
  }
  const version = /^psql \(PostgreSQL\) (18\.\d+)(?:[\s(]|$)/.exec(output);
  if (!version) throw Error("POSTGRES_CLIENT_VERSION_UNSUPPORTED");
  return { clientMajor: 18, clientVersion: version[1] };
}
/** PostgreSQL SSLRequest + verified TLS only. No startup/auth packet or SQL.
 * Production CLI fixes destination and public CA; overrides are for localhost
 * socket tests, not alternate production transports or authentication. */
export function postgresTlsPreflight({ host = "haproxy.home.cz", port = 5000, serverName = host, ca, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let socket,
      secure,
      settled = false;
    const finish = (code, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      secure?.destroy();
      socket?.destroy();
      if (code) reject(Error("POSTGRES_TRANSPORT_PREFLIGHT_" + code));
      else resolve(result);
    };
    const failure = (error) => {
      const code = error?.code;
      finish(
        ["ENOTFOUND", "EAI_AGAIN"].includes(code)
          ? "DNS_FAILED"
          : code === "ECONNREFUSED"
            ? "CONNECTION_REFUSED"
            : [
                  "CERT_HAS_EXPIRED",
                  "DEPTH_ZERO_SELF_SIGNED_CERT",
                  "SELF_SIGNED_CERT_IN_CHAIN",
                  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
                  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
                  "ERR_TLS_CERT_ALTNAME_INVALID"
                ].includes(code)
              ? "TLS_CERTIFICATE_REJECTED"
              : "CONNECTION_FAILED"
      );
    };
    const timer = setTimeout(() => finish("CONNECTION_TIMEOUT"), timeoutMs);
    try {
      socket = tcpConnect({ host, port });
      socket.once("error", failure);
      socket.once("connect", () => {
        const request = Buffer.alloc(8);
        request.writeUInt32BE(8, 0);
        request.writeUInt32BE(80877103, 4);
        socket.write(request);
        socket.once("data", (bytes) => {
          if (bytes.length !== 1 || bytes[0] !== 83) {
            finish("TLS_REQUIRED");
            return;
          }
          secure = tlsConnect({ socket, servername: serverName, ca, rejectUnauthorized: true });
          secure.once("error", failure);
          secure.once("secureConnect", () => {
            if (!secure.authorized) {
              finish("TLS_CERTIFICATE_REJECTED");
              return;
            }
            finish(null, { tlsVerified: true, credentialUsed: false, databaseLoginChecked: false, sqlExecuted: false });
          });
        });
      });
    } catch {
      finish("CONNECTION_FAILED");
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Error("POSTGRES_PREFLIGHT_FIXED_USAGE_REQUIRED");
    const client = verifyPostgresClient();
    const path = "/etc/vcode-cop-pgbouncer/postgres-ca.crt",
      s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) !== 0) throw Error("POSTGRES_PREFLIGHT_TRUSTED_CA_REQUIRED");
    const ca = readFileSync(path);
    if (createHash("sha256").update(ca).digest("hex") !== "7a3f9d9373cd63361148230e6c2804c6fb76dc204e18d5039aad7c7838d7a14a")
      throw Error("POSTGRES_PREFLIGHT_APPROVED_CA_REQUIRED");
    console.log(JSON.stringify({ ...client, ...(await postgresTlsPreflight({ ca })) }));
  } catch (error) {
    console.error(/^[A-Z0-9_]+$/.test(error?.message) ? error.message : "POSTGRES_PREFLIGHT_FAILED");
    process.exitCode = 2;
  }
}
