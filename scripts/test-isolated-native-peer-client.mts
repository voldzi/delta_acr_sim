/**
 * Opt-in Node 24 contract tests ONLY: pinned external source bytes, independent
 * Ajv2020 request validation and injected in-memory exchanges. No native socket,
 * Python/SQLite/process, database, provider, .env or production authority is used.
 * Run: node --import ./apps/ai-router-api/node_modules/tsx/dist/loader.mjs
 *   scripts/test-isolated-native-peer-client.mts --run --wrapper-source /absolute/isolated-linux-wrapper
 * These tests are separate from the wrapper's 40 historical offline tests.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cas, Lease, PeerArgs, PeerMethod, PeerOwner, PeerRequest } from "./lib/isolated-native-peer-client.mts";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Node 24, opt-in synthetic-only: --run --wrapper-source /absolute/isolated-linux-wrapper. No URLs or credentials accepted.");
  process.exit(0);
}
const source = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pins = {
  "peer_wrapper.py": "64e26614bf4512157f09281e0fed7452bdd0c327a6e3f807059a062f027bd69b",
  "peer-request.schema.json": "ed06fbb3b460bd6ba7bc3a48369d90c0944677dce7b7577dc5a3aac0d35aee3e",
  "SOURCE-PINS.json": "eb7a984db9ae661ef8ffac8643fcde29e836b66f4fe0c91dd5b7b8fcb8eab133",
  "../actor-native-isolated/coordinator.py": "5da047bd04aaf3766a3b8ce2572b2ee8eaa38e8439d8462ed277e342a748e01e"
} as const;
const falseFlags = {
  productionAuthorization: false, productionGo: false, actualLinuxAcceptance: false,
  actualRuntimeImageAttestation: false, actualRootEnrollment: false, actualIdentity: false,
  actualProvider: false, actualRestore: false, ownerWideReplayComplete: false, actualSimPreservation: false
} as const;
const results: Array<{ case: string; passed: boolean; errorClass?: string }> = [];
let forbiddenNetworkCalls = 0, exchangeCalls = 0;
let setupStage = "opt_in";
const originalFetch = globalThis.fetch;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const id = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
const clone = <T,>(value: T): T => structuredClone(value);
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
const OWNER: PeerOwner = "sim_ai_router", HANDLE = id(1), BINDING = "3".repeat(64);
const cas: Cas = {
  root_generation: 1, checkpoint_id: id(2), checkpoint_generation: 2,
  checkpoint_digest: "1".repeat(64), frontier_sequence: 3, frontier_digest: "2".repeat(64),
  binding_digest: BINDING, scope_ref: HANDLE, checkpoint_kind: "synthetic-actor-local-not-owner-replay"
};
const refs = {
  "identity-ownership": { evidenceId: id(4), recordDigest: "4".repeat(64) },
  "retention-decision": { evidenceId: id(5), recordDigest: "5".repeat(64) },
  "report-protection": { evidenceId: id(6), recordDigest: "6".repeat(64) },
  "operation-schema": { evidenceId: id(7), recordDigest: "7".repeat(64) }
};
const lease: Lease = { lease_id: id(8), registered_digest: "8".repeat(64), historical: false };
const terminal = { evidenceId: id(10), recordDigest: "a".repeat(64) };
const methodArgs: PeerArgs = {
  current: { handle: HANDLE }, admit: { handle: HANDLE, refs, cas }, begin_commit: { lease, cas },
  complete: { lease, terminal_ref: terminal }, mark_indeterminate: { lease, reason: "unknown" },
  drain: { handle: HANDLE, cas }
};
function request<M extends PeerMethod>(method: M, value: PeerArgs[M] = clone(methodArgs[method]), owner: PeerOwner = OWNER): PeerRequest<M> {
  return { protocol: "cop-actor-peer-isolated-v1", mode: "isolated-fixture-only", owner, requestId: id(20), method, args: value };
}
function response(req: PeerRequest<PeerMethod>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const permit = { permit_id: id(9), lease_id: lease.lease_id, registered_digest: sha256(JSON.stringify({ lease: lease.registered_digest, permit: id(9) })) };
  const result = {
    current: clone(cas), admit: clone(lease), begin_commit: permit,
    complete: "known-terminal-recorded", mark_indeterminate: null,
    drain: { state: "drained", pending_count: 0, fence_id: id(11), frontier_sequence: cas.frontier_sequence, frontier_digest: cas.frontier_digest, owner: req.owner }
  }[req.method];
  return { mode: "isolated-reference-response-only", requestId: req.requestId, result, scopeVersion: 3,
    scopeName: "cop_jizda_preserve_shared_identity_sim", ...falseFlags, ...overrides };
}
async function check(caseName: string, run: () => unknown | Promise<unknown>): Promise<void> {
  try { await run(); results.push({ case: caseName, passed: true }); }
  catch (error) {
    const errorName = error instanceof Error ? error.name : "unknown";
    results.push({ case: caseName, passed: false,
      errorClass: ["AssertionError", "FixtureCodecError", "FixtureUnsupportedError", "FixtureIndeterminateError", "Error"].includes(errorName) ? errorName : "unexpected_error" });
  }
}
function scheduler() {
  let next = 0;
  const pending = new Map<number, () => void>();
  return {
    set(callback: () => void, _ms: number) { const handle = ++next; pending.set(handle, callback); return handle; },
    clear(handle: unknown) { pending.delete(handle as number); },
    fire() { for (const [handle, callback] of [...pending]) { pending.delete(handle); callback(); } },
    get size() { return pending.size; }
  };
}
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

try {
  assert.equal(process.versions.node.split(".")[0], "24", "Use Node.js 24.");
  assert.ok(args.length === 3 && args[0] === "--run" && args[1] === "--wrapper-source" && isAbsolute(args[2]!), "Explicit opt-in and absolute source directory required.");
  const wrapper = resolve(args[2]!);
  setupStage = "external_source_pins";
  assert.ok((await lstat(wrapper)).isDirectory(), "Regular source directory required.");
  const sourceBytes = new Map<string, Buffer>();
  for (const [file, pin] of Object.entries(pins)) {
    const path = join(wrapper, file), info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink(), "Pinned regular source file required.");
    const value = await readFile(path); assert.equal(sha256(value), pin, "Unreviewed external source bytes."); sourceBytes.set(file, value);
  }
  const externalPins = JSON.parse(sourceBytes.get("SOURCE-PINS.json")!.toString("utf8"));
  assert.equal(externalPins.productionAuthorization, false); assert.equal(externalPins.actualLinuxAcceptance, false);
  assert.equal(externalPins.sourceFiles["peer_wrapper.py"], pins["peer_wrapper.py"]);
  assert.equal(externalPins.sourceFiles["peer-request.schema.json"], pins["peer-request.schema.json"]);
  assert.equal(externalPins.reusedFrozenSource["../actor-native-isolated/coordinator.py"], pins["../actor-native-isolated/coordinator.py"]);
  for (const key of Object.keys(process.env)) if (/DATABASE|^PG|OPENAI|API_KEY|SECRET|TOKEN|ERASURE|MEASUREMENTS/u.test(key)) delete process.env[key];
  globalThis.fetch = async () => { forbiddenNetworkCalls++; throw new Error("Network forbidden in isolated contract tests."); };
  setupStage = "independent_schema_compile";
  const require = createRequire(join(source, "apps/situation-data-api/package.json"));
  const Ajv2020 = require("ajv/dist/2020.js").default;
  assert.equal(require("ajv/package.json").version, "8.20.0", "Use the existing pinned SDA Ajv dependency.");
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(sourceBytes.get("peer-request.schema.json")!.toString("utf8")));
  const clientSource = await readFile(join(source, "scripts/lib/isolated-native-peer-client.mts")), clientSourceSha256 = sha256(clientSource);
  setupStage = "isolated_client_import";
  const codec = await import("./lib/isolated-native-peer-client.mts");
  const rejectRequest = (raw: Uint8Array) => assert.throws(() => codec.decodeFixtureRequest(raw), codec.FixtureCodecError);
  const rejectResponse = (raw: Uint8Array, req = request("current")) => assert.throws(() => codec.decodeFixtureResponse(raw, req, BINDING), codec.FixtureCodecError);
  const makeClient = (exchange: (packet: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>, s = scheduler(), owner: PeerOwner = OWNER) =>
    new codec.IsolatedFixtureClient({ mode: "isolated-fixture-only", owner, bindingDigest: BINDING,
      exchange: (packet, signal) => { exchangeCalls++; return exchange(packet, signal); },
      deadlineMs: 10, scheduler: { set: s.set.bind(s), clear: s.clear.bind(s) } });
  const ordinaryExchange = async (packet: Uint8Array) => { const req = codec.decodeFixtureRequest(packet); assert.equal(validate(req), true); return bytes(response(req)); };
  async function freshClient() { const client = makeClient(ordinaryExchange); await client.call("current", { handle: HANDLE }); const admitted = await client.call("admit", clone(methodArgs.admit)); return { client, admitted }; }
  setupStage = "test_cases";

  for (const method of Object.keys(methodArgs) as PeerMethod[]) await check(`schema-and-codec-valid-${method}`, () => {
    const req = request(method), packet = codec.encodeFixtureRequest(req); assert.equal(validate(req), true);
    assert.deepEqual(codec.decodeFixtureRequest(packet), req); const decoded = codec.decodeFixtureResponse(bytes(response(req)), req, BINDING);
    assert.equal(decoded.mode, "isolated-reference-response-only"); for (const field of Object.keys(falseFlags)) assert.equal((decoded as any)[field], false);
  });
  await check("valid-json-order-and-whitespace-not-confused-with-signed-actor-canonicality", () => {
    const req = request("current"); rejectRequest(Buffer.from("\ufeff" + JSON.stringify(req)));
    assert.deepEqual(codec.decodeFixtureRequest(Buffer.from(" \n" + JSON.stringify(Object.fromEntries(Object.entries(req).reverse())) + "\t ")), req);
  });
  await check("frame-empty-nonobject-invalid-utf8-second-document-and-depth", () => {
    for (const packet of [Buffer.alloc(0), Buffer.from("null"), Buffer.from("[]"), Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from(JSON.stringify(request("current")) + "{}"), Buffer.from("[".repeat(800) + "0" + "]".repeat(800))]) rejectRequest(packet);
  });
  await check("byte-boundary-including-multibyte-overflow", () => {
    const valid = bytes(request("current")); assert.ok(valid.length < 16384);
    assert.deepEqual(codec.decodeFixtureRequest(Buffer.concat([valid, Buffer.alloc(16384 - valid.length, 0x20)])), request("current"));
    rejectRequest(Buffer.concat([valid, Buffer.alloc(16385 - valid.length, 0x20)]));
    rejectRequest(Buffer.from(JSON.stringify({ ...request("current"), args: { handle: "ě".repeat(9000) } })));
  });
  await check("duplicate-top-nested-and-escaped-equivalent-keys", () => {
    const req = JSON.stringify(request("admit"));
    for (const raw of [req.replace('"protocol":', '"protocol":"cop-actor-peer-isolated-v1","protocol":'), req.replace('"root_generation":1', '"root_generation":1,"root_generation":1'), req.replace('"root_generation":1', '"root_generation":1,"root_\\u0067eneration":1')]) rejectRequest(Buffer.from(raw));
  });
  for (const numeric of ["1.0", "1e0", "1E+0", "-0.0", "1e999", "NaN", "Infinity", "-Infinity", "9007199254740992", "-1", "true", "null", '"1"']) await check(`reject-counter-token-${numeric.replace(/[^A-Za-z0-9]/g, "_")}`, () => {
    const raw = JSON.stringify(request("admit")).replace('"root_generation":1', `"root_generation":${numeric}`); rejectRequest(Buffer.from(raw));
  });
  await check("independent-schema-does-not-replace-lexical-float-check", () => {
    const raw = JSON.stringify(request("admit")).replace('"root_generation":1', '"root_generation":1.0');
    assert.equal(validate(JSON.parse(raw)), true); rejectRequest(Buffer.from(raw));
  });
  await check("missing-extra-topkeys-and-unsupported-protocol-owner-method-mode", () => {
    for (const key of Object.keys(request("current"))) { const value: any = clone(request("current")); delete value[key]; rejectRequest(bytes(value)); assert.equal(validate(value), false); }
    for (const key of ["uid", "pid", "image", "source", "container", "database", "url", "sql", "authority", "productionAuthorization", "__proto__"]) rejectRequest(bytes({ ...request("current"), [key]: "synthetic-extra" }));
    for (const [key, value] of [["mode", "production"], ["owner", "global"], ["method", "fence"], ["method", "local_commit"], ["method", "dispatch_effect"], ["method", "accept_checkpoint"], ["protocol", "native-messaging"], ["protocol", "cop-actor-peer-isolated-v2"]]) rejectRequest(bytes({ ...request("current"), [key!]: value }));
  });
  await check("canonical-identifiers-digests-exact-args-and-four-independent-refs", () => {
    for (const bad of [id(20).toUpperCase().replace("00000000", "ABCDEF00"), "not-a-uuid", "", null]) rejectRequest(bytes({ ...request("current"), requestId: bad }));
    for (const method of Object.keys(methodArgs) as PeerMethod[]) {
      const req: any = request(method); req.args.extra = true; rejectRequest(bytes(req)); assert.equal(validate(req), false);
      for (const key of Object.keys(methodArgs[method])) { const missing: any = request(method); delete missing.args[key]; rejectRequest(bytes(missing)); }
    }
    for (const kind of Object.keys(refs)) { const req: any = request("admit"); delete req.args.refs[kind]; rejectRequest(bytes(req)); }
    for (const value of ["A".repeat(64), "1".repeat(63), "1".repeat(65), 1]) { const req: any = request("admit"); req.args.cas.checkpoint_digest = value; rejectRequest(bytes(req)); }
    for (const value of [1, "false", null]) { const req: any = request("begin_commit"); req.args.lease.historical = value; rejectRequest(bytes(req)); }
    rejectRequest(bytes(request("mark_indeterminate", { lease, reason: "known-abort" } as any)));
    const unsafe: any = request("admit"); unsafe.args.lease_seconds = 300; rejectRequest(bytes(unsafe));
  });
  await check("independent-schema-safe-counter-inclusive-zero-and-maximum", () => {
    for (const value of [0, Number.MAX_SAFE_INTEGER]) {
      const req: any = request("admit"); req.args.cas.root_generation = value; req.args.cas.checkpoint_generation = value; req.args.cas.frontier_sequence = value;
      assert.equal(validate(req), true); assert.deepEqual(codec.decodeFixtureRequest(codec.encodeFixtureRequest(req)), req);
    }
  });
  await check("encoder-accessor-input-denied-without-invoking-getter", () => {
    let invoked = 0;
    const top: any = request("current"), nested: any = request("current");
    Object.defineProperty(top, "owner", { enumerable: true, get() { invoked++; return OWNER; } });
    Object.defineProperty(nested.args, "handle", { enumerable: true, get() { invoked++; return HANDLE; } });
    assert.throws(() => codec.encodeFixtureRequest(top), codec.FixtureCodecError);
    assert.throws(() => codec.encodeFixtureRequest(nested), codec.FixtureCodecError); assert.equal(invoked, 0);
  });
  await check("response-bad-bytes-duplicate-scope-correlation-and-private-fields", () => {
    const req = request("current"), valid = response(req);
    for (const raw of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from(JSON.stringify(valid) + "{}"), Buffer.alloc(16385, 0x20), Buffer.from(JSON.stringify(valid).replace('"scopeVersion":3', '"scopeVersion":3,"scopeVersion":3'))]) rejectResponse(raw);
    for (const patch of [{ requestId: id(21) }, { scopeVersion: 2 }, { scopeVersion: true }, { scopeName: "global" }, { mode: "production" }, { private_principal: id(22) }, { owner: OWNER }, { method: "current" }, { error: "known-abort" }]) rejectResponse(bytes(response(req, patch)));
  });
  for (const field of Object.keys(falseFlags)) await check(`response-authority-flag-${field}`, () => {
    const req = request("current"), missing = response(req); delete missing[field]; rejectResponse(bytes(missing));
    for (const value of [true, 0, "false", null]) rejectResponse(bytes(response(req, { [field]: value })));
  });
  await check("response-current-full-cas-binding-and-handle", () => {
    const req = request("current");
    for (const patch of [{ scope_ref: id(23) }, { binding_digest: "f".repeat(64) }, { checkpoint_kind: "owner-wide-replay" }, { frontier_sequence: -1 }, { frontier_sequence: 9007199254740992 }, { extra: true }]) rejectResponse(bytes(response(req, { result: { ...cas, ...patch } })));
    rejectResponse(Buffer.from(JSON.stringify(response(req)).replace('"root_generation":1', '"root_generation":1e0')));
  });
  await check("response-method-bound-results-and-registered-permit-digest", () => {
    for (const method of Object.keys(methodArgs) as PeerMethod[]) assert.throws(() => codec.decodeFixtureResponse(bytes(response(request(method), { result: { success: true } })), request(method), BINDING), codec.FixtureCodecError);
    const req = request("begin_commit"), permit: any = response(req).result;
    for (const patch of [{ lease_id: id(24) }, { registered_digest: "f".repeat(64) }, { extra: true }]) assert.throws(() => codec.decodeFixtureResponse(bytes(response(req, { result: { ...permit, ...patch } })), req, BINDING), codec.FixtureCodecError);
    assert.throws(() => codec.decodeFixtureResponse(bytes(response(request("complete"), { result: "known-abort" })), request("complete"), BINDING), codec.FixtureCodecError);
    assert.throws(() => codec.decodeFixtureResponse(bytes(response(request("mark_indeterminate"), { result: false })), request("mark_indeterminate"), BINDING), codec.FixtureCodecError);
    assert.equal(codec.decodeFixtureResponse(bytes(response(request("complete"), { result: "historical-terminal-ack" })), request("complete"), BINDING).result, "historical-terminal-ack");
  });
  await check("response-drain-owner-state-count-no-private-principal", () => {
    const req = request("drain"), valid: any = response(req).result;
    for (const patch of [{ owner: "sim_driver_measurements" }, { state: "pending", pending_count: 0 }, { state: "drained", pending_count: 1 }, { pending_count: -1 }, { pending_count: true }, { private_principal: id(25) }]) assert.throws(() => codec.decodeFixtureResponse(bytes(response(req, { result: { ...valid, ...patch } })), req, BINDING), codec.FixtureCodecError);
    const pending = codec.decodeFixtureResponse(bytes(response(req, { result: { ...valid, state: "pending", pending_count: 1 } })), req, BINDING); assert.equal(pending.result.state, "pending");
  });
  await check("validated-results-are-frozen-and-never-production-compatible", () => {
    const decodedRequest = codec.decodeFixtureRequest(codec.encodeFixtureRequest(request("admit")));
    assert.ok(Object.isFrozen(decodedRequest) && Object.isFrozen(decodedRequest.args));
    const decoded = codec.decodeFixtureResponse(bytes(response(request("current"))), request("current"), BINDING);
    assert.ok(Object.isFrozen(decoded) && Object.isFrozen(decoded.result)); assert.throws(() => { (decoded.result as any).root_generation = 99; }, TypeError);
    assert.deepEqual(codec.negativeProductionProofBridge(), { compatible: false, productionReady: false, reason: "ISOLATED_PROTOCOL_NOT_RUNTIME_AUTHORITY" });
    assert.equal(makeClient(ordinaryExchange).productionReady, false);
  });
  await check("client-requires-isolated-owner-mode-binding-exchange-and-bounded-deadline", () => {
    const s = scheduler(), valid = { mode: "isolated-fixture-only", owner: OWNER, bindingDigest: BINDING, exchange: ordinaryExchange, deadlineMs: 10, scheduler: { set: s.set.bind(s), clear: s.clear.bind(s) } };
    for (const patch of [{ mode: "production" }, { owner: "global" }, { bindingDigest: "A".repeat(64) }, { exchange: undefined }, { deadlineMs: 0 }, { deadlineMs: 1001 }, { deadlineMs: NaN }]) assert.throws(() => new codec.IsolatedFixtureClient({ ...valid, ...patch } as any));
  });
  await check("client-synthetic-method-response-shapes-remain-isolated", async () => {
    const { client, admitted } = await freshClient();
    assert.equal(admitted.result.historical, false);
    await client.call("begin_commit", clone(methodArgs.begin_commit)); await client.call("complete", clone(methodArgs.complete));
    await client.call("drain", clone(methodArgs.drain));
    const another = await freshClient(); await another.client.call("mark_indeterminate", clone(methodArgs.mark_indeterminate));
    assert.equal(client.productionReady, false);
  });
  await check("client-no-current-or-unknown-lease-fails-before-exchange", async () => {
    const before = exchangeCalls, client = makeClient(ordinaryExchange);
    await assert.rejects(client.call("admit", clone(methodArgs.admit)), codec.FixtureUnsupportedError);
    await assert.rejects(client.call("begin_commit", clone(methodArgs.begin_commit)), codec.FixtureUnsupportedError);
    await assert.rejects(client.call("complete", clone(methodArgs.complete)), codec.FixtureUnsupportedError);
    assert.equal(exchangeCalls, before);
  });
  await check("client-all-nine-cas-fields-and-cross-handle-guard", async () => {
    const { client } = await freshClient(), before = exchangeCalls;
    const mutations: Record<string, unknown> = { root_generation: 2, checkpoint_id: id(26), checkpoint_generation: 3, checkpoint_digest: "f".repeat(64), frontier_sequence: 4, frontier_digest: "f".repeat(64), binding_digest: "f".repeat(64), scope_ref: id(27), checkpoint_kind: "owner-wide-replay" };
    for (const [field, value] of Object.entries(mutations)) await assert.rejects(client.call("begin_commit", { lease: clone(lease), cas: { ...cas, [field]: value } } as any));
    await assert.rejects(client.call("admit", { ...clone(methodArgs.admit), handle: id(28) })); assert.equal(exchangeCalls, before);
  });
  await check("client-new-current-invalidates-stale-cas", async () => {
    let changed = false;
    const client = makeClient(async packet => { const req = codec.decodeFixtureRequest(packet); return bytes(response(req, req.method === "current" && changed ? { result: { ...cas, checkpoint_generation: 3 } } : {})); });
    await client.call("current", { handle: HANDLE }); await client.call("admit", clone(methodArgs.admit)); changed = true;
    await client.call("current", { handle: HANDLE }); const before = exchangeCalls;
    await assert.rejects(client.call("begin_commit", clone(methodArgs.begin_commit)), codec.FixtureUnsupportedError); assert.equal(exchangeCalls, before);
  });
  await check("concurrent-current-responses-recheck-capacity-at-observation", async () => {
    let hold = false;
    const delayed: Array<{ req: PeerRequest<PeerMethod>; resolve: (packet: Uint8Array) => void }> = [];
    const client = makeClient(async packet => {
      const req = codec.decodeFixtureRequest(packet);
      if (hold) return new Promise<Uint8Array>(resolve => delayed.push({ req, resolve }));
      return bytes(response(req, { result: { ...cas, scope_ref: (req.args as { handle: string }).handle } }));
    });
    for (let i = 0; i < 127; i++) await client.call("current", { handle: id(1000 + i) });
    hold = true;
    const first = client.call("current", { handle: id(1127) }).then(value => value, error => error);
    const second = client.call("current", { handle: id(1128) }).then(value => value, error => error);
    await flush(); assert.equal(delayed.length, 2);
    delayed[0]!.resolve(bytes(response(delayed[0]!.req, { result: { ...cas, scope_ref: id(1127) } })));
    const accepted = await first; assert.equal(accepted.mode, "isolated-reference-response-only");
    delayed[1]!.resolve(bytes(response(delayed[1]!.req, { result: { ...cas, scope_ref: id(1128) } })));
    const rejected = await second; assert.ok(rejected instanceof codec.FixtureIndeterminateError); assert.equal(rejected.reason, "EXCHANGE_UNKNOWN");
    const before = exchangeCalls; await assert.rejects(client.call("current", { handle: id(1129) }), (error: unknown) => error instanceof codec.FixtureCodecError && error.code === "CAPACITY_LIMIT");
    assert.equal(exchangeCalls, before); assert.equal(client.productionReady, false);
  });
  await check("lease-id-cross-handle-collision-and-historical-ack-downgrade-denied", async () => {
    let firstHandleAdmissions = 0;
    const otherHandle = id(31), otherCas = { ...cas, scope_ref: otherHandle }, historical = { ...lease, historical: true };
    const client = makeClient(async packet => {
      const req = codec.decodeFixtureRequest(packet);
      if (req.method === "current") return bytes(response(req, { result: { ...cas, scope_ref: (req.args as { handle: string }).handle } }));
      if (req.method === "admit" && (req.args as { handle: string }).handle === HANDLE) {
        firstHandleAdmissions++; return bytes(response(req, { result: firstHandleAdmissions === 2 ? historical : lease }));
      }
      return bytes(response(req));
    });
    await client.call("current", { handle: HANDLE }); await client.call("admit", clone(methodArgs.admit));
    await client.call("current", { handle: otherHandle });
    await assert.rejects(client.call("admit", { handle: otherHandle, refs, cas: otherCas }), codec.FixtureIndeterminateError);
    assert.equal((await client.call("admit", clone(methodArgs.admit))).result.historical, true);
    await assert.rejects(client.call("admit", clone(methodArgs.admit)), codec.FixtureIndeterminateError);
    await client.call("complete", { lease: historical, terminal_ref: terminal }); assert.equal(client.productionReady, false);
  });
  await check("historical-lease-not-fresh-admission-but-known-terminal-and-unknown-allowed", async () => {
    const historical = { ...lease, historical: true };
    const client = makeClient(async packet => { const req = codec.decodeFixtureRequest(packet); return bytes(response(req, req.method === "admit" ? { result: historical } : {})); });
    await client.call("current", { handle: HANDLE }); const admitted = await client.call("admit", clone(methodArgs.admit)); assert.equal(admitted.result.historical, true);
    const before = exchangeCalls; await assert.rejects(client.call("begin_commit", { lease: historical, cas }), codec.FixtureUnsupportedError); assert.equal(exchangeCalls, before);
    await client.call("mark_indeterminate", { lease: historical, reason: "disconnect" });
    await client.call("complete", { lease: historical, terminal_ref: terminal }); assert.equal(client.productionReady, false);
  });
  for (const kind of ["throw", "empty", "malformed", "wrong-id", "authority-true"] as const) await check(`exchange-${kind}-unknown-without-retry-or-abort-claim`, async () => {
    let calls = 0;
    const client = makeClient(async packet => { calls++; const req = codec.decodeFixtureRequest(packet);
      if (kind === "throw") throw new Error("synthetic-exchange-failure");
      return kind === "empty" ? Buffer.alloc(0) : kind === "malformed" ? Buffer.from("{") : bytes(response(req, kind === "wrong-id" ? { requestId: id(29) } : { actualRootEnrollment: true })); });
    await assert.rejects(client.call("current", { handle: HANDLE }), (error: unknown) => error instanceof codec.FixtureIndeterminateError && error.code === "INDETERMINATE" && error.reason === "EXCHANGE_UNKNOWN");
    assert.equal(calls, 1); assert.equal(client.productionReady, false);
  });
  await check("safe-errors-never-echo-payload-capability-or-provider-message", async () => {
    const privateFixture = "synthetic-private-capability-not-for-output";
    try { codec.decodeFixtureResponse(bytes(response(request("current"), { result: { ...cas, privateFixture } })), request("current"), BINDING); assert.fail("Rejection required."); }
    catch (error) { assert.ok(error instanceof codec.FixtureCodecError); assert.ok(!error.message.includes(privateFixture) && !error.message.includes(HANDLE)); }
    const client = makeClient(async () => { throw new Error(privateFixture + HANDLE); });
    await assert.rejects(client.call("current", { handle: HANDLE }), (error: unknown) => error instanceof codec.FixtureIndeterminateError && error.message === "INDETERMINATE" && error.reason === "EXCHANGE_UNKNOWN");
  });
  await check("deterministic-deadline-late-response-ignored-no-retry", async () => {
    const s = scheduler(); let calls = 0, resolveLate!: (packet: Uint8Array) => void, lateRequest!: PeerRequest<PeerMethod>;
    const client = makeClient(async packet => { calls++; lateRequest = codec.decodeFixtureRequest(packet); return new Promise<Uint8Array>(resolveLateValue => { resolveLate = resolveLateValue; }); }, s);
    const observed = client.call("current", { handle: HANDLE }).then(() => null, error => error); await flush(); assert.equal(calls, 1); s.fire();
    const error = await observed; assert.ok(error instanceof codec.FixtureIndeterminateError); assert.equal(error.reason, "CALLER_DEADLINE");
    resolveLate(bytes(response(lateRequest))); await flush(); const before = calls;
    await assert.rejects(client.call("admit", clone(methodArgs.admit)), codec.FixtureUnsupportedError); assert.equal(calls, before); assert.equal(client.productionReady, false); assert.equal(s.size, 0);
  });
  await check("four-unsettled-deadlines-retain-capacity-until-late-exchanges-settle", async () => {
    const s = scheduler(); let defer = true, calls = 0;
    const pending: Array<{ req: PeerRequest<PeerMethod>; signal: AbortSignal; resolve: (packet: Uint8Array) => void }> = [];
    const client = makeClient(async (packet, signal) => {
      calls++; const req = codec.decodeFixtureRequest(packet);
      if (defer) return new Promise<Uint8Array>(resolve => pending.push({ req, signal, resolve }));
      return bytes(response(req, { result: { ...cas, scope_ref: (req.args as { handle: string }).handle } }));
    }, s);
    const observed = Array.from({ length: 4 }, (_, i) => client.call("current", { handle: id(2000 + i) }).then(value => value, error => error));
    await flush(); assert.equal(calls, 4); assert.equal(pending.length, 4); assert.equal(s.size, 4); s.fire();
    for (const error of await Promise.all(observed)) { assert.ok(error instanceof codec.FixtureIndeterminateError); assert.equal(error.reason, "CALLER_DEADLINE"); }
    assert.ok(pending.every(row => row.signal.aborted)); assert.equal(s.size, 0);
    await assert.rejects(client.call("current", { handle: id(2004) }), (error: unknown) => error instanceof codec.FixtureCodecError && error.code === "CAPACITY_LIMIT");
    assert.equal(calls, 4);
    for (const row of pending) row.resolve(bytes(response(row.req, { result: { ...cas, scope_ref: (row.req.args as { handle: string }).handle } })));
    defer = false; await flush();
    for (let i = 0; i < 4; i++) await assert.rejects(client.call("admit", { handle: id(2000 + i), refs, cas: { ...cas, scope_ref: id(2000 + i) } }), codec.FixtureUnsupportedError);
    assert.equal(calls, 4); assert.equal(s.size, 0);
    const fresh = await client.call("current", { handle: id(2004) }); assert.equal(fresh.result.scope_ref, id(2004));
    assert.equal(calls, 5); assert.equal(s.size, 0); assert.equal(client.productionReady, false);
  });
  await check("caller-abort-before-and-after-dispatch-never-settles", async () => {
    const before = new AbortController(); before.abort(); let calls = 0;
    const client = makeClient(async () => { calls++; return new Promise<Uint8Array>(() => undefined); });
    await assert.rejects(client.call("current", { handle: HANDLE }, { signal: before.signal }), (error: unknown) => error instanceof codec.FixtureIndeterminateError && error.reason === "CALLER_ABORTED"); assert.equal(calls, 0);
    const after = new AbortController(), pending = client.call("current", { handle: HANDLE }, { signal: after.signal }).then(() => null, error => error); await flush(); assert.equal(calls, 1); after.abort();
    const error = await pending; assert.ok(error instanceof codec.FixtureIndeterminateError); assert.equal(error.reason, "CALLER_ABORTED"); assert.equal(calls, 1); assert.equal(client.productionReady, false);
  });
  await check("client-both-owner-domains-and-binding-isolation", async () => {
    const other: PeerOwner = "sim_driver_measurements";
    const client = makeClient(async packet => { const req = codec.decodeFixtureRequest(packet); assert.equal(req.owner, other); return bytes(response(req)); }, scheduler(), other);
    const current = await client.call("current", { handle: HANDLE }); assert.equal(current.result.binding_digest, BINDING);
    const invalid = makeClient(async packet => { const req = codec.decodeFixtureRequest(packet); return bytes(response(req, { result: { ...cas, binding_digest: "f".repeat(64) } })); });
    await assert.rejects(invalid.call("current", { handle: HANDLE }), codec.FixtureIndeterminateError); assert.equal(client.productionReady, false);
  });
  assert.equal(forbiddenNetworkCalls, 0);
  setupStage = "final_source_pin_recheck";
  assert.equal(sha256(await readFile(join(source, "scripts/lib/isolated-native-peer-client.mts"))), clientSourceSha256, "Client source changed during run.");
  for (const [file, pin] of Object.entries(pins)) assert.equal(sha256(await readFile(join(wrapper, file))), pin, "External source changed during run.");
  console.log(JSON.stringify({ scope: "isolated_typescript_codec_in_memory_client_only", independentRequestSchema: "Ajv2020-existing-SDA-dependency", sourcePins: pins,
    clientSourceSha256, counts: { total: results.length, passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length },
    tests: results, forbiddenNetworkCalls, syntheticExchangeCalls: exchangeCalls, wrapperHistoricalTestsAdded: 0,
    actualNativeTransport: false, actualPostgresTest: false, actualOwnerCallbacks: false, ...falseFlags }, null, 2));
  process.exitCode = results.every(x => x.passed) ? 0 : 1;
} catch {
  console.log(JSON.stringify({ scope: "isolated_typescript_codec_in_memory_client_only", status: "setup_or_source_pin_check_failed", setupStage, testsNotAccepted: true,
    forbiddenNetworkCalls, actualNativeTransport: false, actualPostgresTest: false, ...falseFlags })); process.exitCode = 1;
} finally { globalThis.fetch = originalFetch; }
