import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { patchGateway } from "./deploy-crisis-gateway-freshness.mjs";

const authoritative = readFileSync(new URL("../apps/simulator-web/nginx/default.conf", import.meta.url), "utf8");
const marker = "  # Read-time decisions must never reuse a cached readiness/age response.";
const anchor = "  location /safety-data/api/ {";
const start = authoritative.indexOf(marker);
const end = authoritative.indexOf(anchor, start);
assert.ok(start >= 0 && end > start, "The checked-in authoritative freshness blocks must exist.");
const blocks = authoritative.slice(start, end);
const driverDeny = [
  "  # Runtime-only privacy fence: preserve this divergent route byte for byte.",
  "  location ^~ /situation-data/api/v1/internal/driver-measurements/ {",
  "    return 404;",
  "  }",
  ""
].join("\n");
const runtime = authoritative.replace(blocks, "").replace(anchor, driverDeny + anchor);

function occurrences(value, text) {
  return value.split(text).length - 1;
}

test("inserts exactly the authoritative freshness blocks before the unique safety prefix", () => {
  const next = patchGateway(runtime, authoritative);
  assert.equal(next, runtime.replace(anchor, blocks + anchor));
  assert.equal(occurrences(next, marker), 1);
  assert.equal(occurrences(next, "location = /safety-data/api/v1/notifications/candidates {"), 1);
  assert.equal(occurrences(next, "location = /safety-data/api/v1/context/news {"), 1);
  assert.equal(occurrences(next, anchor), 1);
  assert.equal(next.replace(blocks, ""), runtime);
});

test("preserves the existing driver-measurements deny block and every unrelated byte", () => {
  const divergent =
    "# Existing runtime header: Žádné změny mimo dva decision GETy.\r\n\t# Preserve CRLF, tabs and whitespace.\r\n" +
    runtime +
    "\n# Existing runtime trailer  \n";
  const next = patchGateway(divergent, authoritative);
  assert.equal(occurrences(next, driverDeny), 1);
  assert.equal(next.replace(blocks, ""), divergent);
  const split = divergent.indexOf(anchor);
  assert.equal(next.slice(0, split), divergent.slice(0, split));
  assert.equal(next.slice(split + blocks.length), divergent.slice(split));
});

test("reapplying the exact reviewed patch is idempotent without duplicating routes", () => {
  const first = patchGateway(runtime, authoritative);
  assert.equal(patchGateway(first, authoritative), first);
  assert.equal(patchGateway(patchGateway(first, authoritative), authoritative), first);
});

for (const route of ["notifications/candidates", "context/news"]) {
  test(`rejects an unexpected existing exact ${route} route`, () => {
    const conflict = `  location = /safety-data/api/v1/${route} {\n    return 403;\n  }\n` + runtime;
    assert.throws(() => patchGateway(conflict, authoritative), /unexpected existing decision route/i);
  });
}

test("rejects partially matching existing decision blocks instead of overwriting their policy", () => {
  const incompatible = runtime.replace(anchor, blocks.replace("proxy_cache off;", "proxy_cache on;") + anchor);
  assert.throws(() => patchGateway(incompatible, authoritative), /unexpected existing decision route/i);
});

test("rejects a missing safety prefix anchor", () => {
  assert.throws(() => patchGateway(runtime.replace(anchor, "  location /different-safety-prefix/ {"), authoritative), /unique safety route anchor/i);
});

test("rejects duplicate safety prefix anchors", () => {
  assert.throws(() => patchGateway(runtime + `\n${anchor}\n    return 403;\n  }\n`, authoritative), /unique safety route anchor/i);
});

test("idempotence does not bypass a missing safety prefix anchor", () => {
  const patched = patchGateway(runtime, authoritative);
  assert.throws(() => patchGateway(patched.replace(anchor, "  location /different-safety-prefix/ {"), authoritative), /unique safety route anchor/i);
});

test("idempotence does not bypass duplicate safety prefix anchors", () => {
  const patched = patchGateway(runtime, authoritative);
  assert.throws(() => patchGateway(patched + `\n${anchor}\n    return 403;\n  }\n`, authoritative), /unique safety route anchor/i);
});

test("idempotence does not hide an additional conflicting exact decision route", () => {
  const patched = patchGateway(runtime, authoritative);
  const conflict = "\n  location = /safety-data/api/v1/context/news {\n    return 403;\n  }\n";
  assert.throws(() => patchGateway(patched + conflict, authoritative), /unexpected existing decision route/i);
});

test("rejects an authoritative config without the reviewed marker or insertion anchor", () => {
  assert.throws(() => patchGateway(runtime, authoritative.replace(marker, "  # Different block marker.")), /authoritative freshness blocks are missing/i);
  assert.throws(
    () => patchGateway(runtime, authoritative.replace(anchor, "  location /different-safety-prefix/ {")),
    /authoritative freshness blocks are missing/i
  );
});
