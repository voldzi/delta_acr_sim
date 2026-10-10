import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
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

test("image-only patch preserves all source, cadence, auth and secret bytes", () => {
  const original =
    "SAFETY_DATA_ENABLED_SOURCES=hzs_incidents,chmi_hydro\nMEDIA_NEWS_ENABLED=false\nMEDIA_NEWS_REQUEST_TIMEOUT_MS=1234\nSIM_SAFETY_DATA_IMAGE=old-reviewed\nOTHER_SECRET=synthetic-placeholder\n";
  const next = patchEnvironment(original, "new-reviewed", true);
  assert.equal(next, original.replace("SIM_SAFETY_DATA_IMAGE=old-reviewed", "SIM_SAFETY_DATA_IMAGE=new-reviewed"));
  assert.equal(patchEnvironment(next, "new-reviewed", true), next);
  assert.throws(() => patchEnvironment("MEDIA_NEWS_ENABLED=false\n", "new", true));
  assert.throws(() => patchEnvironment("SIM_SAFETY_DATA_IMAGE=a\nSIM_SAFETY_DATA_IMAGE=b\n", "new", true));
});

test("full-deploy build never retags an already reviewed pinned safety image", () => {
  const script = readFileSync(new URL("./deploy-docker-home.sh", import.meta.url), "utf8");
  const block = script.match(/if \[\[ "\$SIM_SAFETY_DATA_IMAGE_VALUE" != "sim-safety-data-api" \]\]; then[\s\S]*?\nfi\n/)?.[0];
  assert.ok(block);
  const mock =
    'docker() { if [[ "$*" == "compose config --services" ]]; then printf "%s\\n" sim-api safety-data-api flight-data-api; else printf "%s\\n" "$*"; fi; };\n';
  const pinned = spawnSync("bash", ["-c", "SIM_SAFETY_DATA_IMAGE_VALUE=reviewed-image\n" + mock + block], { encoding: "utf8" });
  assert.equal(pinned.status, 0);
  assert.equal(pinned.stdout, "compose build sim-api flight-data-api\ncompose up -d --no-build\n");
  const ordinary = spawnSync("bash", ["-c", "SIM_SAFETY_DATA_IMAGE_VALUE=sim-safety-data-api\n" + mock + block], { encoding: "utf8" });
  assert.equal(ordinary.status, 0);
  assert.equal(ordinary.stdout, "compose up -d --build\n");
});
