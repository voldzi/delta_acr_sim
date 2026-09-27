import { describe, expect, it } from "vitest";
import { copOutboundInput, validCopChatBody, validPublishedContext, validSimIzsBody, type CopChatBody } from "./typed-context.js";

const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const source = {
  kind: "operational_metric", sourceId: "chmi_public", publicationStatus: "published", originType: "official",
  publicationRef: "release_20260927", observedAt: iso(-3 * 3_600_000), publishedAt: iso(-2 * 3_600_000),
  validUntil: iso(24 * 3_600_000), metricId: "station_count", regionCode: "CZ010", value: 42,
  unit: "count", sampleSize: 42
};
const context = { contractVersion: "published-context-v1", attestation: "cop-published-reviewed-v1", items: [source] };
const body = { contractVersion: "cop-chat-byok-v1", billingSource: "user_openai_key", question: "Jaký je souhrn?", allowExternal: true, automaticContext: context };

describe("separate typed contexts", () => {
  it("separates a user's question from a bounded, allowlisted published metric", () => {
    expect(validPublishedContext(context, "cop-published-reviewed-v1", ["chmi_public"], now)).toBe(true);
    expect(validCopChatBody(body, ["chmi_public"])).toBe(true);
    const outbound = copOutboundInput(body as CopChatBody);
    expect(outbound).toContain("Jaký je souhrn?");
    expect(outbound).toContain("release_20260927");
  });

  it("rejects unpublished, expired, unlisted, raw and small-sample data", () => {
    for (const item of [
      { ...source, publicationStatus: "draft" }, { ...source, validUntil: iso(-3_600_000) },
      { ...source, sourceId: "unknown" }, { ...source, rawText: "private report" },
      { ...source, sampleSize: 1 }, { ...source, regionCode: "CZ010123" },
      { ...source, originType: "private" }, { ...source, observedAt: iso(24 * 3_600_000) }
    ]) expect(validPublishedContext({ ...context, items: [item] }, "cop-published-reviewed-v1", ["chmi_public"], now)).toBe(false);
    expect(validPublishedContext({ ...context, items: [{ kind: "chat_message", text: "decrypted" }] }, "cop-published-reviewed-v1", ["chmi_public"], now)).toBe(false);
  });

  it("rejects billing-source override, free context, model choice and user selection", () => {
    for (const added of [{ userId: "another_user" }, { model: "gpt-6-sol" }, { chatContext: "private" }, { billingSource: "sim_project" }, { allowExternal: false }]) {
      expect(validCopChatBody({ ...body, ...added }, ["chmi_public"])).toBe(false);
    }
    expect(validCopChatBody({ ...body, question: "x".repeat(1201) }, ["chmi_public"])).toBe(false);
  });

  it("keeps SIM synthetic and published contexts separate", () => {
    const base = { contractVersion: "sim-izs-summary-v1", billingSource: "sim_project", taskType: "sim_izs_summary", prompt: "Shrň fiktivní cvičení." };
    const synthetic = { ...base, dataClass: "synthetic", context: { contractVersion: "sim-synthetic-context-v1", attestation: "sim-synthetic-reviewed-v1", facts: ["Fiktivní povodeň."] } };
    expect(validSimIzsBody(synthetic, ["chmi_public"])).toBe(true);
    expect(validSimIzsBody({ ...synthetic, context: context }, ["chmi_public"])).toBe(false);
    expect(validSimIzsBody({ ...base, dataClass: "public_aggregate", context: { ...context, attestation: "sim-published-reviewed-v1" } }, ["chmi_public"])).toBe(true);
    expect(validSimIzsBody({ ...base, dataClass: "internal", context }, ["chmi_public"])).toBe(false);
  });
});
