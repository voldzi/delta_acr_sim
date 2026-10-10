import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { patchCompose, patchEnvironment } from "./deploy-crisis-context.mjs";

test("targeted Compose patch changes only safety fields and is idempotent", () => {
  const before = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8")
    .replace("    image: ${SIM_SAFETY_DATA_IMAGE:-sim-safety-data-api}\n", "")
    .replace("      MEDIA_NEWS_ENABLED: ${MEDIA_NEWS_ENABLED:-false}\n", "")
    .replace("      MEDIA_NEWS_REQUEST_TIMEOUT_MS: ${MEDIA_NEWS_REQUEST_TIMEOUT_MS:-8000}\n", "");
  const after = patchCompose(before);
  assert.equal(patchCompose(after), after);
  const undo = (text) =>
    text
      .replace("    image: ${SIM_SAFETY_DATA_IMAGE:-sim-safety-data-api}\n", "")
      .replace("      MEDIA_NEWS_ENABLED: ${MEDIA_NEWS_ENABLED:-false}\n", "")
      .replace("      MEDIA_NEWS_REQUEST_TIMEOUT_MS: ${MEDIA_NEWS_REQUEST_TIMEOUT_MS:-8000}\n", "");
  assert.equal(undo(after), before);
});
test("secret values and custom sources survive scoped environment patch", () => {
  const before = "OTHER_SECRET=example-test-only\nSAFETY_DATA_ENABLED_SOURCES=mock,hzs_incidents\nMEDIA_NEWS_ENABLED=false\n";
  const after = patchEnvironment(before, "sim-safety-data-api:crisis-test");
  assert.ok(after.includes("OTHER_SECRET=example-test-only\n"));
  assert.ok(after.includes("SAFETY_DATA_ENABLED_SOURCES=mock,hzs_incidents,municipal_alerts\n"));
  assert.ok(after.includes("MEDIA_NEWS_ENABLED=true\n"));
  assert.equal(patchEnvironment(after, "sim-safety-data-api:crisis-test"), after);
});
test("ambiguous configuration refuses activation", () => {
  assert.throws(() => patchEnvironment("OTHER_SECRET=example\n", "image"));
  assert.throws(() => patchCompose("services:\n  other:\n    image: test\n"));
  const base = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  assert.throws(() => patchCompose(base.replace("image: ${SIM_SAFETY_DATA_IMAGE:-sim-safety-data-api}", "image: unexpected")));
});
