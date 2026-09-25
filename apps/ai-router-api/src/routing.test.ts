import { describe, expect, it } from "vitest";
import { chooseRoute, classifyDifficulty, estimateMicrousd, taskAllowsDataClass } from "./routing.js";

const policy = { localAvailable: true, externalAvailable: true, advancedAvailable: true, externalEnabled: true };

describe("AI routing policy", () => {
  it("keeps internal data local even with an external preference", () => {
    expect(
      chooseRoute(
        { taskType: "cop_chat", dataClass: "internal", preference: "external", prompt: "Ahoj", allowExternal: true, allowPaidEscalation: true },
        policy
      ).tier
    ).toBe("local_fast");
  });
  it("does not pay for a simple automatic request", () => {
    expect(
      chooseRoute({ taskType: "cop_chat", dataClass: "synthetic", preference: "auto", prompt: "Ahoj", allowExternal: true, allowPaidEscalation: true }, policy)
        .tier
    ).toBe("local_fast");
  });
  it("permits an explicitly approved COP synthetic or public aggregate request only on Luna's economy tier", () => {
    for (const dataClass of ["synthetic", "public_aggregate"] as const) {
      expect(chooseRoute({ taskType: "cop_chat", dataClass, preference: "external", prompt: "Porovnej", allowExternal: true, allowPaidEscalation: true }, policy))
        .toMatchObject({ tier: "external_economy", reason: "approved_cop_external_economy" });
    }
  });
  it("does not fall back from an explicitly selected external COP model", () => {
    expect(() => chooseRoute(
      { taskType: "cop_chat", dataClass: "synthetic", preference: "external", prompt: "Přehled", allowExternal: true, allowPaidEscalation: false },
      { ...policy, externalAvailable: false }
    )).toThrow("external_model_unavailable");
  });
  it("does not escalate without explicit permission", () => {
    expect(
      chooseRoute(
        { taskType: "sim_scenario", dataClass: "synthetic", preference: "auto", prompt: "Návrh", allowExternal: true, allowPaidEscalation: false },
        policy
      ).tier
    ).toBe("external_economy");
  });
  it("allows advanced only for approved complex requests", () => {
    expect(
      chooseRoute(
        { taskType: "sim_scenario", dataClass: "synthetic", preference: "auto", prompt: "Návrh", allowExternal: true, allowPaidEscalation: true },
        policy
      ).tier
    ).toBe("external_advanced");
  });
  it("fails closed when only a local model is permitted but unavailable", () => {
    expect(() =>
      chooseRoute(
        { taskType: "cop_chat", dataClass: "internal", preference: "auto", prompt: "Ahoj", allowExternal: true, allowPaidEscalation: true },
        { ...policy, localAvailable: false }
      )
    ).toThrow("local_model_unavailable");
  });
  it("classifies difficult prompts deterministically", () => {
    expect(classifyDifficulty({ taskType: "cop_chat", prompt: "Porovnej zdroje a rozpory" })).toBe("complex");
  });
  it("reserves output as well as input cost", () => {
    expect(estimateMicrousd(1000, 1000, 0.1, 0.5)).toBe(600);
  });
  it("limits task-specific data classes", () => {
    expect(taskAllowsDataClass("source_health", "internal")).toBe(false);
    expect(taskAllowsDataClass("source_health", "public_aggregate")).toBe(true);
    expect(taskAllowsDataClass("sim_scenario", "synthetic")).toBe(true);
    expect(taskAllowsDataClass("sim_scenario", "public_aggregate")).toBe(false);
  });
});
