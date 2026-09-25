import { describe, expect, it } from "vitest";
import { caller, validBody } from "./app.js";
import type { Config } from "./config.js";
import type { Request } from "express";

const config = {
  copToken: "cop-secret-value-long-enough-123456",
  simToken: "sim-secret-value-long-enough-123456",
  adminToken: "admin-secret-value-long-enough-123456"
} as Config;
const req = (token?: string) => ({ header: () => (token ? `Bearer ${token}` : undefined) }) as unknown as Request;

describe("AI Router request boundary", () => {
  it("requires a service identity", () => {
    expect(caller(req(), config)).toBeNull();
    expect(caller(req("wrong"), config)).toBeNull();
  });
  it("keeps separate COP, SIM and admin identities", () => {
    expect(caller(req(config.copToken), config)).toBe("cop");
    expect(caller(req(config.simToken), config)).toBe("sim");
    expect(caller(req(config.adminToken), config)).toBe("admin");
  });
  it("rejects malformed generation input", () => {
    expect(validBody({ taskType: "cop_chat", dataClass: "internal", prompt: "test", userId: "u" })).toBe(true);
    expect(validBody({ taskType: "cop_chat", dataClass: "internal", prompt: "test", userId: "u", maxOutputTokens: 99999 })).toBe(false);
    expect(validBody({ taskType: "cop_chat", dataClass: "secret", prompt: "test", userId: "u" })).toBe(false);
  });
});
