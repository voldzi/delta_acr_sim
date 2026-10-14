/**
 * Opt-in V5 companion tests: structural Ajv2020, actual pinned pure Python codec
 * helpers through one owned STDIN-to-EOF process, and in-memory client exchanges.
 * NOT a STREAM/SEQPACKET/native transport, registry, database or producer proof.
 * Run with Node 24 and the existing tsx loader: --run --boundary-source /absolute/dormant-boundary-v5
 * V1's 61 tests and Root's 34 historical fixture tests are not executed/changed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DormantArgs, DormantCas, DormantLease, DormantMethod, DormantOperation, DormantRequest } from "./lib/dormant-v5-fixture-client.mts";

const cli = process.argv.slice(2);
if (cli.length === 1 && cli[0] === "--help") {
  console.log("Node 24 opt-in offline only: --run --boundary-source /absolute/dormant-boundary-v5; no URLs, credentials or arbitrary executable accepted."); process.exit(0);
}
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PYTHON = "/opt/homebrew/bin/python3";
const BRIDGE_SHA = "cb40d41f76221a3b311a9ecaeea07aa91eee6926a3b199312b8512d30f5f47fc";
const externalPins = {
  "boundary.py": "f0bffe6f0f6d3b26570050c2a0bcb59d27923e3a347f8967b9aba76240a859dd",
  "request.schema.json": "9cc8241cb5218ce0128d6ebe3fa66ead972b4eaf474145a4458d96879dcd1a50",
  "result.schema.json": "1f3153bc01ff1c9099a96ee1685655147320c0b7aaf2bf4f7e7fdf944511fcd6",
  "SOURCE-PINS.json": "90814725db2f78232d401fbdf83f6f5d99a16a146b67e648adfb76d4d018523f",
  "SCHEMA-FIXTURE-FRAMES.json": "c8163064b00f3f5f25a639dd7646938dff41538622092fd505b0f53a886023eb",
  "../dormant-core-v3/core.py": "b180c23d68cab41d966bca52d08a28fc71ca7fc162c500017f439c91a9401256",
  "../isolated-continuity/isolated-linux-wrapper/peer_wrapper.py": "64e26614bf4512157f09281e0fed7452bdd0c327a6e3f807059a062f027bd69b",
  "../isolated-continuity/isolated-linux-wrapper-v2/linux_fixture.py": "77d47471ba1939b3aa649a8d1973d901849e604db5dd6d27ccc7df29020c25c3"
} as const;
const flags = {
  productionAuthorization: false, actualProducer: false, actualAdmission: false, actualIdentity: false,
  actualOwnerEvidence: false, actualIndependentAnchor: false, actualProvider: false, actualSimPreservation: false,
  actualRestore: false, ownerWideReplayComplete: false, kernelDatabaseAtomicityClaim: false
} as const;
const PROTOCOL = "cop-dormant-boundary-fixture-v5" as const;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const id = (value: number) => `00000000-0000-0000-0000-${value.toString(16).padStart(12, "0")}`;
const copy = <T,>(value: T): T => structuredClone(value);
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value));
const operation: DormantOperation = { operationId: id(1), bodyDigest: "c".repeat(64), schemaDigest: "d".repeat(64), operationCode: "cop-actor-write" };
const cas: DormantCas = { scopeRef: operation.operationId, orderSequence: 1, orderDigest: "1".repeat(64), checkpointId: id(2), checkpointGeneration: 0,
  checkpointDigest: "2".repeat(64), fenceSequence: 0, fenceDigest: "0".repeat(64) };
const lease: DormantLease = { leaseId: id(8), requestDigest: "e".repeat(64), historical: false };
const refs: DormantArgs["admit"]["refs"] = {
  "identity-ownership": { recordId: id(4), recordDigest: "4".repeat(64) },
  "retention-decision": { recordId: id(5), recordDigest: "5".repeat(64) },
  "report-protection": { recordId: id(6), recordDigest: "6".repeat(64) },
  "operation-schema": { recordId: id(7), recordDigest: "7".repeat(64) }
};
const methodArgs: DormantArgs = { current: {}, admit: { cas, refs, leaseSeconds: 60 }, begin_commit: { cas, lease }, unknown: { lease, reason: "unknown" },
  settle: { lease, observed: { recordId: id(10), recordDigest: "a".repeat(64) } }, drain: { cas } };
const resultShapes = { current: { cas }, admit: { lease, ack: "fixture-registered" }, begin_commit: { permit: { permitId: id(9), leaseId: lease.leaseId, requestDigest: "f".repeat(64) } },
  unknown: { state: "registered-pending" }, settle: { state: "synthetic-original-terminal-recorded" }, drain: { state: "fixture-drained", pending: 0, scope: "principal" } };
function request<M extends DormantMethod>(method: M, args: DormantArgs[M] = copy(methodArgs[method]), requestId = id(20)): DormantRequest<M> {
  return { protocol: PROTOCOL, mode: "own-fixture-only", requestId, bindingDigest: "b".repeat(64), method, operation: copy(operation), args };
}
function canonical(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function wireSuccess(req: DormantRequest<DormantMethod>, result: unknown = copy(resultShapes[req.method])) {
  const frameDigest = hash(canonical(req)), correlationDigest = hash(canonical({ protocol: PROTOCOL, requestId: req.requestId, method: req.method, operationId: req.operation.operationId, frameDigest }));
  return { protocol: PROTOCOL, mode: "own-fixture-only", requestId: req.requestId, bindingDigest: req.bindingDigest, method: req.method, frameDigest, correlationDigest, result, flags: copy(flags) };
}
interface Job { caseIndex: number; action: "decode" | "encode_result" | "encode_error"; requestBase64: string; result?: unknown }
interface PythonRecord { caseIndex: number; accepted: boolean; errorClass?: string; canonicalBase64?: string; frameDigest?: string; correlationDigest?: string; responseBase64?: string }
const jobs: Job[] = [], tests: Array<{ name: string; run: () => unknown | Promise<unknown> }> = [], results: Array<{ case: string; passed: boolean; errorClass?: string }> = [];
const add = (name: string, run: () => unknown | Promise<unknown>) => tests.push({ name, run });
function queue(action: Job["action"], packet: Uint8Array, result?: unknown): number {
  assert.ok(jobs.length < 128); const caseIndex = jobs.length;
  jobs.push({ caseIndex, action, requestBase64: Buffer.from(packet).toString("base64"), ...(action === "encode_result" ? { result } : {}) }); return caseIndex;
}
function scheduler() {
  let next = 0; const callbacks = new Map<number, () => void>();
  return { set(callback: () => void, _ms: number) { const key = ++next; callbacks.set(key, callback); return key; }, clear(key: unknown) { callbacks.delete(key as number); },
    fire() { for (const [key, callback] of [...callbacks]) { callbacks.delete(key); callback(); } }, get size() { return callbacks.size; } };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
let stage = "opt_in", forbiddenNetworkCalls = 0, inMemoryExchangeCalls = 0, pythonProcessCount = 0;
let pythonRecords = new Map<number, PythonRecord>();
const originalFetch = globalThis.fetch;
const pythonRecord = (index: number) => { const record = pythonRecords.get(index); assert.ok(record); return record; };

async function pythonBridge(executable: string, bridge: Buffer, source: string): Promise<any> {
  const input = bytes({ testProtocol: "sim-dormant-v5-codec-test-batch-v1", cases: jobs }); assert.ok(input.byteLength <= 1048576);
  pythonProcessCount++;
  return await new Promise((resolveBridge, reject) => {
    // Execute the exact hash-verified bytes, not a mutable/untrusted script path.
    const child = spawn(executable, ["-I", "-S", "-B", "-c", bridge.toString("utf8"), "--run", "--boundary-source", source],
      { shell: false, cwd: repo, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let outputBytes = 0, stderrBytes = 0, failed = false;
    const timeout = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, 5000);
    child.stdout.on("data", (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 1048576) { failed = true; child.kill("SIGKILL"); } else chunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 16384) { failed = true; child.kill("SIGKILL"); } });
    child.on("error", () => { clearTimeout(timeout); reject(new Error("PYTHON_BRIDGE_UNAVAILABLE")); });
    child.on("close", code => { clearTimeout(timeout);
      if (failed || code !== 0 || stderrBytes !== 0) { reject(new Error("PYTHON_BRIDGE_FAILED")); return; }
      try { resolveBridge(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("PYTHON_BRIDGE_INVALID_OUTPUT")); }
    });
    child.stdin.on("error", () => { failed = true; child.kill("SIGKILL"); }); child.stdin.end(input);
  });
}

try {
  assert.equal(process.versions.node.split(".")[0], "24");
  assert.ok(cli.length === 3 && cli[0] === "--run" && cli[1] === "--boundary-source" && isAbsolute(cli[2]!));
  const source = resolve(cli[2]!); stage = "pinned_source_reads";
  assert.ok((await lstat(source)).isDirectory());
  const external = new Map<string, Buffer>();
  for (const [name, pin] of Object.entries(externalPins)) {
    const path = join(source, name), meta = await lstat(path); assert.ok(meta.isFile() && meta.nlink === 1 && meta.size <= 1048576);
    const data = await readFile(path); assert.equal(hash(data), pin); external.set(name, data);
  }
  const manifest = JSON.parse(external.get("SOURCE-PINS.json")!.toString("utf8"));
  assert.equal(manifest.protocol, PROTOCOL); assert.equal(manifest.acceptedWire, false); assert.equal(manifest.productionAuthorization, false);
  const sourceFrames = JSON.parse(external.get("SCHEMA-FIXTURE-FRAMES.json")!.toString("utf8"));
  assert.equal(sourceFrames.acceptedWire, false); assert.equal(sourceFrames.frames.length, 4);
  const bridgePath = join(repo, "scripts/dormant-fixture-python-bridge.py"), bridge = await readFile(bridgePath); assert.equal(hash(bridge), BRIDGE_SHA);
  const modulePaths = ["scripts/lib/dormant-v5-fixture-client.mts", "scripts/lib/dormant-fixture-json.mts"];
  const clientSourcePins = Object.fromEntries(await Promise.all(modulePaths.map(async name => [name, hash(await readFile(join(repo, name)))])));
  const pythonExecutable = await realpath(PYTHON), pythonMetadata = await lstat(pythonExecutable);
  assert.ok(pythonExecutable.startsWith("/opt/homebrew/Cellar/") && pythonMetadata.isFile() && (pythonMetadata.mode & 0o111) !== 0 && (pythonMetadata.mode & 0o022) === 0);
  for (const key of Object.keys(process.env)) if (/DATABASE|^PG|OPENAI|API_KEY|SECRET|TOKEN|ERASURE|MEASUREMENTS/u.test(key)) delete process.env[key];
  globalThis.fetch = async () => { forbiddenNetworkCalls++; throw new Error("NETWORK_FORBIDDEN"); };
  stage = "schema_and_companion_import";
  const require = createRequire(join(repo, "apps/situation-data-api/package.json")); assert.equal(require("ajv/package.json").version, "8.20.0");
  const Ajv2020 = require("ajv/dist/2020.js").default, ajv = new Ajv2020({ strict: true, allErrors: true });
  const reqSchema = JSON.parse(external.get("request.schema.json")!.toString("utf8")), resSchema = JSON.parse(external.get("result.schema.json")!.toString("utf8"));
  const validateRequest = ajv.compile(reqSchema), validateResult = ajv.compile(resSchema);
  const codec = await import("./lib/dormant-v5-fixture-client.mts"), json = await import("./lib/dormant-fixture-json.mts");
  const rejects = (run: () => unknown) => assert.throws(run);
  const helperDenials: Array<[string, Buffer, string]> = [
    ["utf8", Buffer.from([0xff]), "INVALID_UTF8"], ["bom", Buffer.from("\ufeff{}"), "BOM_NOT_ALLOWED"],
    ["duplicate-escaped-key", Buffer.from('{"a":1,"\\u0061":2}'), "DUPLICATE_KEY"],
    ["float", Buffer.from("1.0"), "FLOAT_TOKEN"], ["exponent", Buffer.from("1e0"), "FLOAT_TOKEN"],
    ["unsafe-integer", Buffer.from("9007199254740992"), "UNSAFE_INTEGER"],
    ["depth", Buffer.from("[".repeat(13) + "0" + "]".repeat(13)), "STRUCTURE_LIMIT"],
    ["nodes", bytes(Array.from({ length: 32 }, () => Array(7).fill(0))), "STRUCTURE_LIMIT"],
    ["array", bytes(Array(33).fill(0)), "ARRAY_LIMIT"], ["key", bytes({ ["x".repeat(65)]: 0 }), "KEY_LIMIT"],
    ["string", bytes("x".repeat(257)), "STRING_LIMIT"], ["surrogate", Buffer.from('"\\ud800"'), "UNPAIRED_SURROGATE"],
    ["frame-overflow", Buffer.alloc(16385, 0x20), "INVALID_PACKET"], ["empty-frame", Buffer.alloc(0), "INVALID_PACKET"]
  ];
  for (const [name, packet, expectedCode] of helperDenials) add(`direct-helper-exact-denial-${name}`, () => {
    assert.throws(() => json.parseStrictFixturePacket(packet), (error: unknown) => error instanceof json.FixtureJsonError && error.code === expectedCode);
  });
  add("direct-helper-inclusive-depth-node-array-key-string-byte-boundaries", () => {
    assert.deepEqual(normalized(json.parseStrictFixturePacket(Buffer.from("[".repeat(12) + "0" + "]".repeat(12)))), JSON.parse("[".repeat(12) + "0" + "]".repeat(12)));
    const exactNodes = Array.from({ length: 32 }, (_, i) => Array(i === 31 ? 6 : 7).fill(0));
    assert.deepEqual(normalized(json.parseStrictFixturePacket(bytes(exactNodes))), exactNodes);
    assert.equal((json.parseStrictFixturePacket(bytes(Array(32).fill(0))) as unknown[]).length, 32);
    assert.equal(Object.keys(json.parseStrictFixturePacket(bytes({ ["k".repeat(64)]: 0 })) as object)[0]!.length, 64);
    assert.equal((json.parseStrictFixturePacket(bytes("x".repeat(256))) as string).length, 256);
    assert.equal(json.parseStrictFixturePacket(Buffer.concat([Buffer.from("0"), Buffer.alloc(16383, 0x20)])), 0);
    assert.equal(json.parseStrictFixturePacket(Buffer.from("9007199254740991")), Number.MAX_SAFE_INTEGER);
  });
  add("direct-canonical-ascii-del-control-escaping-and-negative-zero", () => {
    assert.equal(Buffer.from(json.canonicalAsciiFixtureBytes({ x: "\x7f" })).toString("ascii"), '{"x":"\\u007f"}');
    assert.equal(Buffer.from(json.canonicalAsciiFixtureBytes({ x: "\b\f\n\r\t" })).toString("ascii"), '{"x":"\\b\\f\\n\\r\\t"}');
    assert.equal(Buffer.from(json.canonicalAsciiFixtureBytes(-0)).toString("ascii"), "0");
  });
  add("canonical-proxy-accessor-and-tojson-hooks-never-invoked", () => {
    let proxyTraps = 0, getters = 0, toJsonCalls = 0;
    const proxy = new Proxy({}, { ownKeys() { proxyTraps++; return []; }, getPrototypeOf() { proxyTraps++; return Object.prototype; }, get() { proxyTraps++; return null; } });
    const accessor = Object.defineProperty({}, "x", { enumerable: true, get() { getters++; return 0; } });
    const toJson = { toJSON() { toJsonCalls++; return {}; } };
    for (const value of [proxy, accessor, toJson]) assert.throws(() => json.canonicalAsciiFixtureBytes(value), (error: unknown) => error instanceof json.FixtureJsonError && error.code === "INVALID_CANONICAL_VALUE");
    assert.equal(proxyTraps, 0); assert.equal(getters, 0); assert.equal(toJsonCalls, 0);
  });

  for (const [i, pair] of sourceFrames.frames.entries()) {
    const decode = queue("decode", bytes(pair.request)), encoded = queue("encode_result", bytes(pair.request), pair.response.result);
    add(`root-emitted-synthetic-pair-${i + 1}-schema-canonical-and-python-encoder`, () => {
      assert.equal(validateRequest(pair.request), true); assert.equal(validateResult(pair.response), true);
      const py = pythonRecord(decode); assert.equal(py.accepted, true);
      const ts = codec.decodeDormantRequest(bytes(pair.request)); assert.equal(Buffer.from(codec.encodeDormantRequest(ts)).toString("base64"), py.canonicalBase64);
      assert.deepEqual(codec.dormantRequestDigests(ts), { frameDigest: py.frameDigest, correlationDigest: py.correlationDigest });
      assert.equal(py.frameDigest, pair.response.frameDigest); assert.equal(py.correlationDigest, pair.response.correlationDigest);
      const encoder = pythonRecord(encoded); assert.equal(encoder.accepted, true);
      assert.deepEqual(JSON.parse(Buffer.from(encoder.responseBase64!, "base64").toString("utf8")), pair.response);
      const decoded = codec.decodeDormantResponse(bytes(pair.response), ts); assert.ok("result" in decoded); assert.deepEqual(normalized(decoded.flags), flags);
    });
  }
  const encodedByMethod = new Map<DormantMethod, number>();
  for (const method of Object.keys(methodArgs) as DormantMethod[]) {
    const req = request(method), dec = queue("decode", bytes(req)), enc = queue("encode_result", bytes(req), copy(resultShapes[method])); encodedByMethod.set(method, enc);
    add(`six-method-${method}-actual-python-canonical-digest-result`, () => {
      assert.equal(validateRequest(req), true); const py = pythonRecord(dec); assert.equal(py.accepted, true);
      const ts = codec.decodeDormantRequest(bytes(req)); assert.equal(Buffer.from(codec.encodeDormantRequest(ts)).toString("base64"), py.canonicalBase64);
      assert.deepEqual(codec.dormantRequestDigests(ts), { frameDigest: py.frameDigest, correlationDigest: py.correlationDigest });
      const res = pythonRecord(enc); assert.equal(res.accepted, true); const packet = Buffer.from(res.responseBase64!, "base64");
      assert.equal(validateResult(JSON.parse(packet.toString("utf8"))), true); assert.deepEqual(normalized(codec.decodeDormantResponse(packet, req)), wireSuccess(req));
    });
  }
  const malformed: Array<[string, Buffer]> = [
    ["empty", Buffer.alloc(0)], ["invalid-utf8", Buffer.from([0xff])], ["bom", Buffer.from("\ufeff" + JSON.stringify(request("current")))],
    ["second-document", Buffer.from(JSON.stringify(request("current")) + "{}")], ["root-array", Buffer.from("[]")],
    ["frame-overflow", Buffer.alloc(16385, 0x20)], ["multibyte-overflow", Buffer.from(JSON.stringify({ ...request("current"), extra: "ě".repeat(9000) }))],
    ["escaped-surrogate", Buffer.from(JSON.stringify(request("current")).replace('"args":{}', '"args":{"x":"\\ud800"}'))],
    ["depth-overflow", Buffer.from(JSON.stringify(request("current")).replace('"args":{}', '"args":{"x":' + "[".repeat(13) + "0" + "]".repeat(13) + "}"))],
    ["array-overflow", bytes({ ...request("current"), args: { x: Array(33).fill(0) } })],
    ["node-overflow", bytes({ ...request("current"), args: { x: Array.from({ length: 32 }, () => Array(8).fill(0)) } })],
    ["key-overflow", bytes({ ...request("current"), args: { ["x".repeat(65)]: 0 } })],
    ["string-overflow", bytes({ ...request("current"), args: { x: "x".repeat(257) } })],
    ["duplicate-top", Buffer.from(JSON.stringify(request("current")).replace('"method":"current"', '"method":"current","method":"current"'))],
    ["duplicate-nested-escaped", Buffer.from(JSON.stringify(request("admit")).replace('"orderSequence":1', '"orderSequence":1,"order\\u0053equence":1'))]
  ];
  for (const numeric of ["1.0", "1e0", "1e999", "NaN", "Infinity", "9007199254740992", "-1", "true"]) malformed.push([`counter-token-${numeric.replace(/[^a-z0-9]/gi, "_")}`, Buffer.from(JSON.stringify(request("admit")).replace('"orderSequence":1', `"orderSequence":${numeric}`))]);
  for (const [name, packet] of malformed) {
    const job = queue("decode", packet); add(`python-and-typescript-byte-request-denial-${name}`, () => { assert.equal(pythonRecord(job).accepted, false); assert.equal(pythonRecord(job).errorClass, "Denied"); rejects(() => codec.decodeDormantRequest(packet)); });
  }
  for (const [name, patch] of [["protocol-v4", { protocol: "cop-dormant-boundary-fixture-v4" }], ["protocol-v1", { protocol: "cop-actor-peer-isolated-v1" }], ["production-mode", { mode: "production" }], ["foreign-owner", { owner: "sim_ai_router" }], ["database-selector", { database: "synthetic" }], ["admin-method", { method: "register" }]] as const) {
    const packet = bytes({ ...request("current"), ...patch }), job = queue("decode", packet);
    add(`python-and-typescript-exact-envelope-${name}`, () => { assert.equal(pythonRecord(job).accepted, false); rejects(() => codec.decodeDormantRequest(packet)); assert.equal(validateRequest(JSON.parse(packet.toString("utf8"))), false); });
  }
  const relational: Array<[string, DormantRequest<DormantMethod>, any]> = [
    ["permit-foreign-request-lease", request("begin_commit"), { permit: { ...resultShapes.begin_commit.permit, leaseId: id(99) } }],
    ["ack-historical-mismatch", request("admit"), { lease: { ...lease, historical: true }, ack: "fixture-registered" }],
    ["drain-count-state-mismatch", request("drain"), { state: "fixture-drained", pending: 1, scope: "principal" }],
    ["drain-foreign-operation-scope", request("drain"), { state: "fixture-drained", pending: 0, scope: "owner-wide" }],
    ["cas-foreign-operation", request("current"), { cas: { ...cas, scopeRef: id(99) } }],
    ["private-result-fields", request("current"), { cas, privatePrincipal: id(99) }],
    ["unknown-not-known-abort", request("unknown"), { state: "aborted" }]
  ];
  for (const [name, req, result] of relational) {
    const job = queue("encode_result", bytes(req), result);
    add(`actual-python-encoder-and-typescript-relational-denial-${name}`, () => { assert.equal(pythonRecord(job).accepted, false); assert.equal(pythonRecord(job).errorClass, "Denied"); rejects(() => codec.decodeDormantResponse(bytes(wireSuccess(req, result)), req)); });
  }
  const wrongCas: any = request("admit"); wrongCas.args.cas.scopeRef = id(99); const wrongCasJob = queue("decode", bytes(wrongCas));
  add("schema-alone-allows-cas-crossfield-and-lexical-float-but-decoders-deny", () => {
    assert.equal(validateRequest(wrongCas), true); assert.equal(pythonRecord(wrongCasJob).accepted, false); rejects(() => codec.decodeDormantRequest(bytes(wrongCas)));
    assert.equal(validateRequest(JSON.parse(JSON.stringify(request("admit")).replace('"orderSequence":1', '"orderSequence":1.0'))), true);
  });
  const canonicalSpaced = Buffer.from(" \n" + JSON.stringify(Object.fromEntries(Object.entries(request("admit")).reverse())) + "\t "), spaced = queue("decode", canonicalSpaced);
  add("canonical-crosslanguage-whitespace-keyorder-and-safe-counter-boundaries", () => {
    assert.equal(pythonRecord(spaced).accepted, true); assert.deepEqual(codec.dormantRequestDigests(codec.decodeDormantRequest(canonicalSpaced)), codec.dormantRequestDigests(request("admit")));
    for (const value of [0, Number.MAX_SAFE_INTEGER]) { const req: any = request("admit"); req.args.cas.orderSequence = value; assert.equal(validateRequest(req), true); assert.equal(codec.decodeDormantRequest(codec.encodeDormantRequest(req)).args !== undefined, true); }
  });
  const errorValid = queue("encode_error", bytes(request("current"))), errorInvalid = queue("encode_error", Buffer.from([0xff]));
  add("actual-python-safe-errors-correlated-or-null-are-only-unresolved", () => {
    for (const index of [errorValid, errorInvalid]) { const item = pythonRecord(index); assert.equal(item.accepted, true); const packet = Buffer.from(item.responseBase64!, "base64"); assert.equal(validateResult(JSON.parse(packet.toString("utf8"))), true);
      const decoded = codec.decodeDormantResponse(packet, request("current")); assert.ok("error" in decoded); assert.equal(decoded.error.operationOutcome, "unknown-not-settled"); }
  });
  add("response-correlation-binding-method-version-and-private-fields-denied", () => {
    const req = request("current"), valid = wireSuccess(req);
    for (const patch of [{ requestId: id(99) }, { bindingDigest: "f".repeat(64) }, { frameDigest: "f".repeat(64) }, { correlationDigest: "f".repeat(64) }, { method: "drain" }, { protocol: "cop-dormant-boundary-fixture-v4" }, { mode: "production" }, { privatePrincipal: id(99) }, { owner: "sim_ai_router" }]) rejects(() => codec.decodeDormantResponse(bytes({ ...valid, ...patch }), req));
    const validError = JSON.parse(Buffer.from(pythonRecord(errorValid).responseBase64!, "base64").toString("utf8")); validError.correlation.requestId = id(99); rejects(() => codec.decodeDormantResponse(bytes(validError), req));
  });
  for (const flag of Object.keys(flags)) add(`all-eleven-actual-flags-remain-false-${flag}`, () => {
    const req = request("current"), res: any = wireSuccess(req); res.flags[flag] = true; assert.equal(validateResult(res), false); rejects(() => codec.decodeDormantResponse(bytes(res), req)); delete res.flags[flag]; rejects(() => codec.decodeDormantResponse(bytes(res), req));
  });
  add("lease-and-permit-digests-preserved-as-distinct-opaque-values", () => {
    const a = codec.decodeDormantResponse(Buffer.from(pythonRecord(encodedByMethod.get("admit")!).responseBase64!, "base64"), request("admit"));
    const p = codec.decodeDormantResponse(Buffer.from(pythonRecord(encodedByMethod.get("begin_commit")!).responseBase64!, "base64"), request("begin_commit"));
    assert.ok("result" in a && "result" in p); assert.equal(a.result.lease.requestDigest, lease.requestDigest); assert.equal(p.result.permit.requestDigest, "f".repeat(64));
    assert.notEqual(a.result.lease.requestDigest, a.frameDigest); assert.notEqual(p.result.permit.requestDigest, p.frameDigest); assert.notEqual(p.result.permit.requestDigest, a.result.lease.requestDigest);
  });
  add("own-historical-marker-is-informational-not-an-unforgeable-provenance-claim", () => {
    const req = request("admit"), decoded = codec.decodeDormantResponse(bytes(wireSuccess(req, { lease: { ...lease, historical: true }, ack: "historical-only" })), req);
    assert.ok("result" in decoded); assert.equal(decoded.result.ack, "historical-only"); assert.equal(decoded.flags.actualAdmission, false);
  });
  const makeClient = (exchange: (packet: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>, s = scheduler(), op = copy(operation)) =>
    new codec.DormantV5FixtureClient({ mode: "own-fixture-only", operation: op, bindingDigest: "b".repeat(64), deadlineMs: 10,
      scheduler: { set: s.set.bind(s), clear: s.clear.bind(s) }, exchange: (packet, signal) => { inMemoryExchangeCalls++; return exchange(packet, signal); } });
  add("client-fixed-operation-snapshot-no-per-call-identity-or-selector-change", async () => {
    const mutable = copy(operation); let seen = 0;
    const client = makeClient(async packet => { seen++; const req = codec.decodeDormantRequest(packet); assert.deepEqual(normalized(req.operation), operation); return bytes(wireSuccess(req)); }, scheduler(), mutable);
    (mutable as any).bodyDigest = "a".repeat(64); await client.call("current", {}, { requestId: id(20) });
    await assert.rejects(client.call("current", {}, { requestId: id(20), operation: mutable } as any)); assert.equal(seen, 1); assert.equal(client.productionReady, false);
  });
  add("client-known-error-and-invalid-response-never-fallback-or-authorize", async () => {
    for (const kind of ["error", "invalid", "throw"] as const) { let count = 0;
      const client = makeClient(async () => { count++; if (kind === "throw") throw new Error("synthetic-private-value"); return kind === "invalid" ? Buffer.from("{") : Buffer.from(pythonRecord(errorValid).responseBase64!, "base64"); });
      await assert.rejects(client.call("current", {}, { requestId: id(20) }), codec.DormantIndeterminateError); assert.equal(count, 1); assert.equal(client.productionReady, false); }
  });
  add("client-null-correlated-null-packet-and-malformed-errors-are-only-unknown", async () => {
    for (const kind of ["null-correlated", "null-packet", "malformed-error"] as const) {
      let calls = 0;
      const client = makeClient(async () => {
        calls++;
        if (kind === "null-correlated") return Buffer.from(pythonRecord(errorInvalid).responseBase64!, "base64");
        if (kind === "null-packet") return Buffer.from("null");
        const malformed = JSON.parse(Buffer.from(pythonRecord(errorValid).responseBase64!, "base64").toString("utf8"));
        malformed.error.operationOutcome = "known-abort"; return bytes(malformed);
      });
      await assert.rejects(client.call("current", {}, { requestId: id(20) }), (error: unknown) => error instanceof codec.DormantIndeterminateError &&
        error.reason === (kind === "null-correlated" ? "FIXTURE_UNKNOWN" : "EXCHANGE_UNKNOWN"));
      assert.equal(calls, 1); assert.equal(client.productionReady, false);
    }
  });
  add("client-preaborted-caller-never-dispatches-exchange", async () => {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    const client = makeClient(async packet => { calls++; return bytes(wireSuccess(codec.decodeDormantRequest(packet))); });
    await assert.rejects(client.call("current", {}, { requestId: id(40), signal: controller.signal }), (error: unknown) => error instanceof codec.DormantIndeterminateError && error.reason === "CALLER_ABORTED");
    assert.equal(calls, 0); assert.equal(client.productionReady, false);
  });
  add("client-synchronous-deadline-before-queued-dispatch-never-exchanges", async () => {
    let calls = 0, cleared = 0;
    const client = new codec.DormantV5FixtureClient({ mode: "own-fixture-only", operation, bindingDigest: "b".repeat(64), deadlineMs: 10,
      scheduler: { set(callback) { callback(); return 1; }, clear() { cleared++; } }, exchange: async packet => { calls++; return bytes(wireSuccess(codec.decodeDormantRequest(packet))); } });
    await assert.rejects(client.call("current", {}, { requestId: id(41) }), (error: unknown) => error instanceof codec.DormantIndeterminateError && error.reason === "CALLER_DEADLINE");
    await flush(); assert.equal(calls, 0); assert.equal(cleared, 1); assert.equal(client.productionReady, false);
  });
  add("client-inflight-abort-keeps-slot-until-underlying-exchange-settlement", async () => {
    const s = scheduler(), controllers = Array.from({ length: 4 }, () => new AbortController());
    let defer = true, calls = 0;
    const pending: Array<{ req: DormantRequest<DormantMethod>; resolve: (value: Uint8Array) => void }> = [];
    const client = makeClient(async packet => { calls++; const req = codec.decodeDormantRequest(packet);
      if (defer) return new Promise<Uint8Array>(resolve => pending.push({ req, resolve })); return bytes(wireSuccess(req)); }, s);
    const observed = controllers.map((controller, i) => client.call("current", {}, { requestId: id(50 + i), signal: controller.signal }).then(value => value, error => error));
    await flush(); assert.equal(calls, 4); controllers[0]!.abort();
    assert.ok((await observed[0]) instanceof codec.DormantIndeterminateError);
    await assert.rejects(client.call("current", {}, { requestId: id(54) }), (error: unknown) => error instanceof codec.DormantCodecError && error.code === "CAPACITY_LIMIT"); assert.equal(calls, 4);
    for (const controller of controllers.slice(1)) controller.abort();
    for (const error of await Promise.all(observed)) { assert.ok(error instanceof codec.DormantIndeterminateError); assert.equal(error.reason, "CALLER_ABORTED"); }
    assert.equal(s.size, 0); for (const row of pending) row.resolve(bytes(wireSuccess(row.req))); defer = false; await flush();
    await client.call("current", {}, { requestId: id(55) }); assert.equal(calls, 5); assert.equal(s.size, 0); assert.equal(client.productionReady, false);
  });
  add("client-four-deadlines-keep-unsettled-slots-late-responses-not-success", async () => {
    const s = scheduler(); const pending: Array<{ req: DormantRequest<DormantMethod>; resolve: (value: Uint8Array) => void }> = []; let defer = true, calls = 0;
    const client = makeClient(async packet => { calls++; const req = codec.decodeDormantRequest(packet); if (defer) return new Promise<Uint8Array>(resolve => pending.push({ req, resolve })); return bytes(wireSuccess(req)); }, s);
    const observed = Array.from({ length: 4 }, (_, i) => client.call("current", {}, { requestId: id(30 + i) }).then(value => value, error => error)); await flush(); assert.equal(calls, 4); s.fire();
    for (const error of await Promise.all(observed)) { assert.ok(error instanceof codec.DormantIndeterminateError); assert.equal(error.reason, "CALLER_DEADLINE"); }
    await assert.rejects(client.call("current", {}, { requestId: id(34) }), (error: unknown) => error instanceof codec.DormantCodecError && error.code === "CAPACITY_LIMIT"); assert.equal(calls, 4);
    for (const row of pending) row.resolve(bytes(wireSuccess(row.req))); defer = false; await flush(); assert.equal(s.size, 0);
    await client.call("current", {}, { requestId: id(35) }); assert.equal(calls, 5); assert.equal(s.size, 0); assert.equal(client.productionReady, false);
  });
  add("negative-production-proof-bridge-and-root-flags-never-positive-authority", () => {
    assert.deepEqual(codec.negativeDormantProductionProofBridge(), { compatible: false, productionReady: false, reason: "DORMANT_FIXTURE_NOT_RUNTIME_AUTHORITY" });
    const req = request("current"), res = codec.decodeDormantResponse(bytes(wireSuccess(req)), req); assert.deepEqual(normalized(res.flags), flags); assert.ok(Object.isFrozen(res));
    rejects(() => json.canonicalAsciiFixtureBytes({ x: "ě" }));
  });

  stage = "one_owned_pure_python_bridge";
  const output = await pythonBridge(pythonExecutable, bridge, source);
  assert.equal(output.testProtocol, "sim-dormant-v5-codec-test-batch-v1"); assert.equal(output.scope, "pure_pinned_python_helpers_only"); assert.deepEqual(output.flags, flags);
  assert.equal(output.actualNativeTransport, false); assert.equal(output.actualDatabase, false); assert.equal(output.actualCoreLoaded, false); assert.equal(output.rootHistoricalTestsAdded, 0);
  assert.equal(output.records.length, jobs.length); assert.ok(Object.values(output.guards).every(value => value === 0));
  pythonRecords = new Map(output.records.map((item: PythonRecord) => [item.caseIndex, item])); assert.equal(pythonRecords.size, jobs.length);
  stage = "registered_test_cases";
  for (const test of tests) {
    try { await test.run(); results.push({ case: test.name, passed: true }); }
    catch (error) { const name = error instanceof Error ? error.name : "unknown";
      results.push({ case: test.name, passed: false, errorClass: ["AssertionError", "DormantCodecError", "DormantIndeterminateError", "FixtureJsonError", "Error"].includes(name) ? name : "unexpected_error" }); }
  }
  stage = "source_pin_recheck";
  for (const [name, pin] of Object.entries(externalPins)) assert.equal(hash(await readFile(join(source, name))), pin);
  for (const [name, pin] of Object.entries(clientSourcePins)) assert.equal(hash(await readFile(join(repo, name))), pin);
  assert.equal(hash(await readFile(bridgePath)), BRIDGE_SHA); assert.equal(forbiddenNetworkCalls, 0); assert.equal(pythonProcessCount, 1);
  console.log(JSON.stringify({ scope: "dormant_v5_schema_pure_python_codec_and_in_memory_client_only", protocol: PROTOCOL, mode: "own-fixture-only", sourcePins: externalPins,
    bridgeSha256: BRIDGE_SHA, clientSourcePins, independentSchemas: "Ajv2020-existing-SDA-dependency", counts: { total: results.length, passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length },
    tests: results, rootEmittedSyntheticPairs: 4, purePythonHelperCases: jobs.length, pythonProcessCount, pythonVersion: output.pythonVersion, pythonAuditGuards: output.guards, inMemoryExchangeCalls, forbiddenNetworkCalls,
    actualPurePythonHelpers: true, actualNativeTransport: false, actualDatabase: false, actualCoreLoaded: false, actualOwnerCallbacks: false, actualRegistryLeaseProvenance: false,
    rootHistoricalTestsAdded: 0, v1HistoricalTestsAdded: 0, acceptedWire: false, productionReady: false, flags }, null, 2));
  process.exitCode = results.every(item => item.passed) ? 0 : 1;
} catch {
  console.log(JSON.stringify({ scope: "dormant_v5_schema_pure_python_codec_and_in_memory_client_only", status: "setup_pin_guard_or_bridge_failed", stage,
    testsNotAccepted: true, pythonProcessCount, forbiddenNetworkCalls, actualNativeTransport: false, actualDatabase: false, productionReady: false, flags })); process.exitCode = 1;
} finally { globalThis.fetch = originalFetch; }
