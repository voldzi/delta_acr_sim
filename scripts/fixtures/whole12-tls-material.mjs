/** Public fixture tooling; writes ONLY fresh owned synthetic TLS material. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath, mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
const exec = promisify(execFile);
export async function prepareWhole12Tls(root) {
  assert.ok(/^\/private\/tmp\/sim-user-install-pg-[A-Za-z0-9_-]+$/.test(root) || root === "/dev/shm/cop-clean-whole12-9aff26e65b74-pg");
  const s = await lstat(root);
  assert.ok(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o777) === 0o700);
  assert.equal(await realpath(root), root);
  const dir = join(root, "tls");
  const clientRoot = root.startsWith("/dev/shm/") ? "/private/tmp/sim-user-install-pg-9aff26e65b74" : root;
  await mkdir(dir, { mode: 0o700 });
  const run = async (args) => exec("openssl", args, { cwd: dir, env: { PATH: process.env.PATH }, maxBuffer: 65536 });
  for (const name of ["ca", "wrong-ca"])
    await run([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=SIM whole12 isolated " + name,
      "-addext",
      "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-addext",
      "subjectKeyIdentifier=hash",
      "-addext",
      "authorityKeyIdentifier=keyid:always",
      "-keyout",
      name + ".key",
      "-out",
      name + ".pem"
    ]);
  await run(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=haproxy.home.cz", "-keyout", "server.key", "-out", "server.csr"]);
  await writeFile(
    join(dir, "server.ext"),
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectAltName=DNS:haproxy.home.cz\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n",
    { mode: 0o600 }
  );
  await run([
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    "server.ext",
    "-out",
    "server.pem"
  ]);
  for (const name of ["ca.key", "wrong-ca.key", "server.key"]) await chmod(join(dir, name), 0o600);
  await writeFile(join(dir, "hosts"), "127.0.0.1 localhost haproxy.home.cz\n::1 localhost\n", { mode: 0o600 });
  await writeFile(
    join(dir, "pg_hba.conf"),
    "local all fixture_admin trust\nlocal all all scram-sha-256\nhostssl all all 127.0.0.1/32 scram-sha-256\nhostnossl all all 127.0.0.1/32 reject\n",
    { mode: 0o600 }
  );
  return {
    fixtureOnly: true,
    root,
    postgres: {
      port: 5000,
      listen_addresses: "127.0.0.1",
      cluster_name: "sim_whole12_tls_fixture_v1",
      ssl: "on",
      ssl_cert_file: join(clientRoot, "tls/server.pem"),
      ssl_key_file: join(clientRoot, "tls/server.key"),
      hba_file: join(clientRoot, "tls/pg_hba.conf"),
      unix_socket_directories: join(clientRoot, "s")
    },
    clientReadOnlyMounts: [
      { source: join(dir, "hosts"), target: "/etc/hosts" },
      { source: join(dir, "ca.pem"), target: "/etc/csm-sim/postgresql-ca.pem" }
    ],
    ca: await readFile(join(dir, "ca.pem"), "utf8"),
    wrongCa: await readFile(join(dir, "wrong-ca.pem"), "utf8")
  };
}
