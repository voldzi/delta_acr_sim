import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewCleanupCron, verifyInventorySource } from "./inspect-sim-root-inventory.mjs";
const line = "*/15 * * * * /synthetic/driver-measurements-cleanup.sh";
const hash = createHash("sha256").update(line).digest("hex");
test("exact active cleanup line is fingerprinted without exposing command", () => {
  const result = reviewCleanupCron("# synthetic header\n" + line + "\n", hash);
  assert.equal(result.state, "exact_expected_line_still_active");
  assert.equal(result.lineNumber, 2);
  assert.ok(!JSON.stringify(result).includes("/synthetic/"));
  assert.equal(result.mutated, false);
});
test("removed or commented cleanup is truthfully absent, not falsely matched", () => {
  for (const text of ["", "# " + line + "\n"]) {
    const result = reviewCleanupCron(text, hash);
    assert.equal(result.state, "no_active_measurement_line");
    assert.equal(result.activeMeasurementLineCount, 0);
  }
});
test("changed line or duplicate producer refuses review", () => {
  assert.throws(() => reviewCleanupCron(line + " --changed", hash));
  assert.throws(() => reviewCleanupCron(line + "\n" + line, hash));
});
test("all executable source dependencies match exact ca1fd6b bytes", () =>
  assert.equal(verifyInventorySource(resolve(dirname(fileURLToPath(import.meta.url)), "..")), 3));
