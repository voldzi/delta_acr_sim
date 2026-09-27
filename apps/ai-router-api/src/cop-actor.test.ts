import { createHmac } from "node:crypto";
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { verifyCopActor } from "./cop-actor.js";

const secret = "cop-actor-test-secret-long-enough-123456";
const now = 1_800_000_000;
function actorRequest(claim: Record<string, unknown>, signedWith = secret): Request {
  const encoded = Buffer.from(JSON.stringify(claim)).toString("base64url");
  const signature = createHmac("sha256", signedWith).update(encoded).digest("hex");
  return { header: (name: string) => name === "x-cop-actor" ? encoded : name === "x-cop-actor-signature" ? signature : undefined } as unknown as Request;
}

describe("signed COP actor", () => {
  it("accepts only a short-lived opaque service-attested identity", () => {
    const claim = { sub: "opaque_user_1234", aud: "sim-ai-router", iat: now - 10, exp: now + 40 };
    expect(verifyCopActor(actorRequest(claim), secret, now)).toEqual(claim);
    expect(verifyCopActor(actorRequest(claim, "different-actor-test-secret-long-enough"), secret, now)).toBeNull();
    expect(verifyCopActor(actorRequest({ ...claim, sub: "person@example.cz" }), secret, now)).toBeNull();
    expect(verifyCopActor(actorRequest({ ...claim, aud: "other" }), secret, now)).toBeNull();
    expect(verifyCopActor(actorRequest({ ...claim, exp: now - 1 }), secret, now)).toBeNull();
    expect(verifyCopActor(actorRequest({ ...claim, exp: now + 3600 }), secret, now)).toBeNull();
    expect(verifyCopActor(actorRequest({ ...claim, userId: "other_user" }), secret, now)).toBeNull();
  });
});
