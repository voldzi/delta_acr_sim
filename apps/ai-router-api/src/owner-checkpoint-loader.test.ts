import { afterEach, describe, expect, it, vi } from "vitest";
const fs = vi.hoisted(() => ({ lstat: vi.fn(), realpath: vi.fn(), readdir: vi.fn() }));
vi.mock("node:fs/promises", () => fs);
import { loadProductionOwnerCheckpointVerifier } from "./owner-checkpoint.js";
import type { Checkpoint } from "./account-erasure.js";

const modulePath = "/opt/cop-account-safety/ai-root-inspect.mjs";
const item = (file = false, changes: Record<string, unknown> = {}) => ({ uid: 0, mode: file ? 0o644 : 0o755, nlink: 1,
  isSymbolicLink: () => false, isFile: () => file, isDirectory: () => !file, ...changes });
function setup() {
  fs.lstat.mockImplementation(async path => item(path === modulePath || path.endsWith("/helper.mjs")));
  fs.realpath.mockResolvedValue(modulePath); fs.readdir.mockResolvedValue(["helper.mjs"]);
}
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
describe("fixed production checkpoint loader fail-closed custody (mock filesystem only)", () => {
  it("denies a missing installation and emits only a fixed non-secret warning", async () => {
    fs.lstat.mockRejectedValue(Error("synthetic secret-bearing path")); const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const verify = await loadProductionOwnerCheckpointVerifier(); expect(await verify({} as Checkpoint)).toBe(false);
    expect(warning).toHaveBeenCalledWith('{"event":"ai_router_checkpoint_authority_unavailable","code":"OWNER_BINDING_UNAVAILABLE"}');
  });
  it("rejects non-Root, writable and symlink ancestors before realpath/import", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of [item(false, { uid: 1000 }), item(false, { mode: 0o777 }), item(false, { isSymbolicLink: () => true })]) {
      setup(); fs.lstat.mockImplementation(async path => path === "/opt" ? bad : item(path === modulePath));
      expect(await (await loadProductionOwnerCheckpointVerifier())({} as Checkpoint)).toBe(false);
      expect(fs.realpath).not.toHaveBeenCalled();
    }
  });
  it("rejects a hard-linked entry point and a path mismatch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {}); setup();
    fs.lstat.mockImplementation(async path => item(path === modulePath, path === modulePath ? { nlink: 2 } : {}));
    expect(await (await loadProductionOwnerCheckpointVerifier())({} as Checkpoint)).toBe(false); expect(fs.readdir).not.toHaveBeenCalled();
    setup(); fs.realpath.mockResolvedValue("/untrusted/other.mjs");
    expect(await (await loadProductionOwnerCheckpointVerifier())({} as Checkpoint)).toBe(false); expect(fs.readdir).not.toHaveBeenCalled();
  });
  it("checks dependency custody before importing the Root entry point", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of [item(true, { uid: 1000 }), item(true, { mode: 0o666 }), item(true, { nlink: 2 }),
      item(true, { isFile: () => false, isDirectory: () => false })]) {
      setup(); fs.lstat.mockImplementation(async path => path.endsWith("/helper.mjs") ? bad : item(path === modulePath));
      expect(await (await loadProductionOwnerCheckpointVerifier())({} as Checkpoint)).toBe(false);
      expect(fs.lstat).toHaveBeenCalledWith("/opt/cop-account-safety/helper.mjs");
    }
  });
  it("bounds traversal depth and never selects a path from environment", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {}); setup(); fs.readdir.mockResolvedValue(["nested"]);
    expect(await (await loadProductionOwnerCheckpointVerifier())({} as Checkpoint)).toBe(false);
    expect(fs.readdir.mock.calls.length).toBe(65);
    expect(fs.lstat.mock.calls.every(([path]) => ["/", "/opt"].includes(path) || path.startsWith("/opt/cop-account-safety"))).toBe(true);
  });
});
