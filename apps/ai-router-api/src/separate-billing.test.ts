import { randomBytes } from "node:crypto";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { PgSeparateBilling, SeparateBillingError } from "./separate-billing.js";

function fakePool() {
  const rows = new Map<string, { ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer; fingerprint: string; updated_at: Date }>();
  const audits: Array<{ action: string; fingerprint: string }> = [];
  const aggregate = { day_total: "0", month_total: "0", day_count: "0" };
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith("SELECT fingerprint FROM ai_router_user_key")) {
        const row = rows.get(String(params[0]));
        return { rows: row ? [{ fingerprint: row.fingerprint }] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.startsWith("INSERT INTO ai_router_user_key ")) {
        rows.set(String(params[0]), { ciphertext: params[1] as Buffer, nonce: params[2] as Buffer,
          auth_tag: params[3] as Buffer, fingerprint: String(params[4]), updated_at: new Date() });
      }
      if (sql.startsWith("DELETE FROM ai_router_user_key")) {
        const row = rows.get(String(params[0])); rows.delete(String(params[0]));
        return { rows: row ? [{ fingerprint: row.fingerprint }] : [] };
      }
      if (sql.startsWith("INSERT INTO ai_router_user_key_audit")) audits.push({ action: sql.includes("'removed'") ? "removed" : String(params[1]), fingerprint: String(params.at(-1)) });
      if (sql.includes("AS day_total")) return { rows: [aggregate] };
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined
  };
  const pool = {
    connect: async () => client,
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith("SELECT ciphertext")) {
        const row = rows.get(String(params[0])); return { rows: row ? [row] : [] };
      }
      if (sql.startsWith("SELECT fingerprint, updated_at")) {
        const row = rows.get(String(params[0])); return { rows: row ? [row] : [] };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  return { pool: pool as unknown as pg.Pool, rows, audits, aggregate };
}

describe("encrypted keys and separate billing", () => {
  it("stores only AES-GCM ciphertext bound to the opaque user and handles replacement/removal", async () => {
    const { pool, rows, audits } = fakePool();
    const store = new PgSeparateBilling(pool, randomBytes(32).toString("base64"));
    const key = "sk-user-one-key-long-enough-123456";
    const saved = await store.putKey("cop:user_one", key);
    expect(saved.fingerprint).toHaveLength(16);
    expect(rows.get("cop:user_one")?.ciphertext.toString("utf8")).not.toContain(key);
    expect(await store.getKey("cop:user_one")).toEqual({ apiKey: key, fingerprint: saved.fingerprint });
    expect(await store.getKey("cop:user_two")).toBeNull();
    expect(await store.keyStatus("cop:user_one")).toMatchObject({ configured: true, fingerprint: saved.fingerprint });
    const replacement = await store.putKey("cop:user_one", "sk-user-one-rotated-long-enough-123456");
    expect(replacement.fingerprint).not.toBe(saved.fingerprint);
    expect((await store.getKey("cop:user_one"))?.apiKey).toContain("rotated");
    await store.removeKey("cop:user_one");
    expect(await store.getKey("cop:user_one")).toBeNull();
    expect(audits.map((entry) => entry.action)).toEqual(["created", "replaced", "removed"]);
  });

  it("rejects tampering and enforces the new lane's caps before a reservation", async () => {
    const { pool, rows, aggregate } = fakePool();
    const store = new PgSeparateBilling(pool, randomBytes(32).toString("base64"));
    await store.putKey("cop:user_one", "sk-user-one-key-long-enough-123456");
    const row = rows.get("cop:user_one")!;
    row.auth_tag[0] = row.auth_tag[0]! ^ 1;
    await expect(store.getKey("cop:user_one")).rejects.toThrow();
    await expect(store.reserve("user_openai_key", "cop:user_one", "cop:user_one", "fingerprint", null,
      "cop_chat", "gpt-6-luna", 2, { dailyMicrousd: 1, monthlyMicrousd: 10, dailyRequests: 10 }))
      .rejects.toMatchObject({ code: "daily_budget_exceeded" } satisfies Partial<SeparateBillingError>);
    aggregate.day_total = "3"; aggregate.month_total = "9";
    await expect(store.reserve("user_openai_key", "cop:user_one", "cop:user_one", "fingerprint", null,
      "cop_chat", "gpt-6-luna", 2, { dailyMicrousd: 10, monthlyMicrousd: 10, dailyRequests: 10 }))
      .rejects.toMatchObject({ code: "monthly_budget_exceeded" } satisfies Partial<SeparateBillingError>);
    aggregate.month_total = "3"; aggregate.day_count = "10";
    await expect(store.reserve("user_openai_key", "cop:user_one", "cop:user_one", "fingerprint", null,
      "cop_chat", "gpt-6-luna", 2, { dailyMicrousd: 10, monthlyMicrousd: 10, dailyRequests: 10 }))
      .rejects.toMatchObject({ code: "user_daily_limit_exceeded" } satisfies Partial<SeparateBillingError>);
  });
});
