import { describe, expect, it } from "vitest";
import { BudgetError, BudgetStore } from "./budget.js";

describe("AI Router policy hard caps", () => {
  const limits = { dailyMicrousd: 1_000_000, monthlyMicrousd: 10_000_000, perUserDailyRequests: 10 };
  it("rejects an increase beyond the environment cap before touching the database", async () => {
    const store = new BudgetStore("postgres://localhost/test", "test-secret", limits);
    await expect(store.updatePolicy({ externalAllowed: false, advancedAllowed: false, limits: { ...limits, dailyMicrousd: 1_000_001 } })).rejects.toMatchObject(
      { code: "policy_exceeds_environment_cap" } satisfies Partial<BudgetError>
    );
    await store.close();
  });
  it("rejects advanced models without the external tier", async () => {
    const store = new BudgetStore("postgres://localhost/test", "test-secret", limits);
    await expect(store.updatePolicy({ externalAllowed: false, advancedAllowed: true, limits })).rejects.toMatchObject({
      code: "advanced_requires_external"
    } satisfies Partial<BudgetError>);
    await store.close();
  });
  it("hashes distinct users without storing their raw names", async () => {
    const store = new BudgetStore("postgres://localhost/test", "test-secret", limits);
    expect(store.hashUser("cop", "alice")).not.toContain("alice");
    expect(store.hashUser("cop", "alice")).not.toBe(store.hashUser("sim", "alice"));
    await store.close();
  });
});
