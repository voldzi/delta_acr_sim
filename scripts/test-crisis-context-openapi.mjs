import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const document = JSON.parse(readFileSync(new URL("../openapi/openapi.json", import.meta.url), "utf8"));
const fragment = JSON.parse(readFileSync(new URL("../openapi/fragments/crisis-context-v1.openapi.json", import.meta.url), "utf8"));
const targets = ["/safety-data/api/v1/notifications/candidates", "/safety-data/api/v1/context/news"];
const httpMethods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function operation(path, method) {
  const value = document.paths[path]?.[method];
  assert.ok(value, `${method.toUpperCase()} ${path} must remain in the composite contract`);
  return value;
}

function effectiveSecurity(value) {
  return Object.hasOwn(value, "security") ? value.security : document.security;
}

test("the composite bearer default remains protected", () => {
  assert.deepEqual(document.security, [{ bearerAuth: [] }]);
  assert.equal(document.components.securitySchemes.bearerAuth.type, "http");
  assert.equal(document.components.securitySchemes.bearerAuth.scheme, "bearer");
});

test("exactly the two crisis read-only GET operations declare the internal network policy", () => {
  const declared = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, value] of Object.entries(item)) {
      if (!httpMethods.has(method) || value["x-access-policy"] !== "internal_network_readonly") continue;
      declared.push(`${method.toUpperCase()} ${path}`);
    }
  }
  assert.deepEqual(declared.sort(), targets.map((path) => `GET ${path}`).sort());
  for (const path of targets) {
    const value = operation(path, "get");
    assert.deepEqual(value.security, []);
    assert.equal(value["x-access-policy"], "internal_network_readonly");
    assert.equal(value["x-server-to-server"], true);
    assert.match(value.description, /trusted internal\/VPN network read-only/i);
    assert.match(value.description, /not a public anonymous endpoint/i);
    assert.match(value.description, /external networks are denied.*gateway allowlist/i);
  }
});

test("the authoritative news fragment carries the same explicit override", () => {
  assert.deepEqual(Object.keys(fragment.paths), ["/context/news"]);
  const value = fragment.paths["/context/news"].get;
  assert.deepEqual(value.security, []);
  assert.equal(value["x-access-policy"], "internal_network_readonly");
  assert.deepEqual(value.security, operation("/safety-data/api/v1/context/news", "get").security);
});

test("known unrelated application and provider operations retain their bearer requirements", () => {
  const protectedOperations = [
    ["/api/v1/scenarios", "post", "bearerAuth"],
    ["/api/v1/publisher/stop", "post", "bearerAuth"],
    ["/safety-data/api/v1/features", "get", "bearerAuth"],
    ["/safety-data/api/v1/catalog", "get", "bearerAuth"],
    ["/situation-data/api/v1/routing/route", "post", "bearerAuth"],
    ["/situation-data/api/v1/geo-routing-v1/route", "post", "geoRoutingServiceBearer"],
    ["/situation-data/api/v1/internal/valhalla-traffic/feed", "get", "ValhallaTrafficBearer"],
    ["/situation-data/api/v1/internal/driver-measurements/v1/batches", "post", "driverMeasurementCopBearer"],
    ["/api/v1/ai-router/cop/chat", "post", "aiRouterBearer"],
    ["/tak-gateway/api/v1/cot/events", "post", "bearerAuth"]
  ];
  for (const [path, method, scheme] of protectedOperations) {
    const value = operation(path, method);
    assert.deepEqual(effectiveSecurity(value), [{ [scheme]: [] }], `${method.toUpperCase()} ${path} security must remain unchanged`);
    assert.notEqual(value["x-access-policy"], "internal_network_readonly");
  }
});
