import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DriverRevocationActorError, verifyDriverRevocationActor, type DriverRevocationActor } from "../src/driver-revocation-actor.js";

// Fresh local HMAC fixtures exercise only signed-claim parsing. They are NOT
// verified sessions, consent-ledger evidence, daily derivation or Root authority.
const secret = "synthetic-revocation-actor-secret-at-least-thirty-two";
const issuer = "https://synthetic.invalid/identity";
const contributorIdDay = "synthetic_day_identifier_" + "x".repeat(20);
const now = Date.parse("2026-10-15T12:00:00.500Z"), seconds = Math.floor(now / 1000);
const actor: DriverRevocationActor = {
  iss: issuer, sub: "synthetic-account", aud: "sim-driver-revocation", iat: seconds, exp: seconds + 60,
  contributorDay: "2026-10-15", contributorIdDay, actorSource: "verified_session"
};
function signature(header: string, key = secret) { return createHmac("sha256", key).update(header).digest("hex"); }
function encoded(text: string) { const header = Buffer.from(text, "utf8").toString("base64url"); return { header, signature: signature(header) }; }
function signed(value: unknown = actor) { return encoded(JSON.stringify(value)); }
function verify(value: unknown = actor, at = now, requestId = contributorIdDay) {
  const proof = signed(value); return verifyDriverRevocationActor(proof.header, proof.signature, secret, issuer, requestId, at);
}
function rejects(work: () => unknown) {
  try { work(); } catch (error) {
    expect(error).toBeInstanceOf(DriverRevocationActorError);
    expect(error).toMatchObject({ status: 401, code: "DRIVER_REVOCATION_ACTOR_INVALID" });
    return;
  }
  throw new Error("Expected the fixed revocation actor error");
}

describe("Driver revocation actor: exact local signed claim only", () => {
  it.each(["verified_session", "consent_ledger"] as const)("accepts %s and returns a typed frozen flat claim", actorSource => {
    const expected = { ...actor, actorSource }, actual = verify(expected);
    expect(actual).toEqual(expected); expect(Object.isFrozen(actual)).toBe(true);
    expect(Object.keys(actual)).toEqual(["iss", "sub", "aud", "iat", "exp", "contributorDay", "contributorIdDay", "actorSource"]);
    expect(() => { (actual as { sub: string }).sub = "replacement"; }).toThrow(TypeError);
  });

  it("keeps historical IDs eligible and validates leap days without a retention cutoff", () => {
    for (const contributorDay of ["0000-01-01", "1900-01-01", "2024-02-29", "2026-01-01"])
      expect(verify({ ...actor, contributorDay }).contributorDay).toBe(contributorDay);
  });

  it("accepts the next UTC day only inside the thirty-second midnight tolerance", () => {
    const before = Date.parse("2026-10-15T23:59:29.999Z"), at = Date.parse("2026-10-15T23:59:30.000Z");
    const claim = { ...actor, contributorDay: "2026-10-16", iat: Math.floor(at / 1000), exp: Math.floor(at / 1000) + 60 };
    expect(verify(claim, at).contributorDay).toBe("2026-10-16");
    rejects(() => verify({ ...claim, iat: Math.floor(before / 1000), exp: Math.floor(before / 1000) + 60 }, before));
  });

  it("uses floored current seconds and the exact inclusive sixty-second TTL", () => {
    expect(verify({ ...actor, iat: seconds - 59, exp: seconds + 1 }).exp).toBe(seconds + 1);
    expect(verify({ ...actor, iat: seconds, exp: seconds + 1 }).iat).toBe(seconds);
    for (const claim of [{ ...actor, exp: seconds }, { ...actor, exp: seconds - 1 },
      { ...actor, iat: seconds + 1, exp: seconds + 2 }, { ...actor, exp: seconds + 61 },
      { ...actor, iat: seconds - 61, exp: seconds - 1 }, { ...actor, exp: seconds - 1, iat: seconds }]) rejects(() => verify(claim));
  });

  it.each([
    ["issuer", { iss: "https://other.synthetic.invalid/identity" }],
    ["audience", { aud: "sim-account-erasure" }],
    ["different body ID", { contributorIdDay: "z".repeat(43) }],
    ["missing source", { actorSource: undefined }],
    ["unknown source", { actorSource: "operator_claim" }],
    ["future day", { contributorDay: "2026-10-16" }],
    ["invalid leap day", { contributorDay: "2025-02-29" }],
    ["invalid month day", { contributorDay: "2026-04-31" }],
    ["invalid month", { contributorDay: "2026-13-01" }],
    ["noncanonical day", { contributorDay: "2026-1-01" }],
    ["timestamp instead of day", { contributorDay: "2026-10-15T00:00:00Z" }],
    ["numeric day", { contributorDay: 20261015 }],
    ["empty subject", { sub: "" }],
    ["long subject", { sub: "x".repeat(513) }],
    ["non-string subject", { sub: 1 }],
    ["negative issued time", { iat: -1, exp: 1 }],
    ["fractional issued time", { iat: seconds + 0.5 }],
    ["fractional expiry", { exp: seconds + 1.5 }],
    ["text issued time", { iat: String(seconds) }],
    ["text expiry", { exp: String(seconds + 60) }],
    ["unsafe issued time", { iat: Number.MAX_SAFE_INTEGER + 1 }],
    ["unsafe expiry", { exp: Number.MAX_SAFE_INTEGER + 1 }],
    ["non-finite issued time", { iat: Number.POSITIVE_INFINITY }],
    ["non-finite expiry", { exp: Number.NaN }],
  ] as [string, Record<string, unknown>][])("rejects signed %s", (_name, change) => { rejects(() => verify({ ...actor, ...change })); });

  it("rejects C0/DEL/C1 subject controls but accepts bounded Unicode subjects", () => {
    for (const sub of ["\u0000", "\n", "\t", "\r", "\u001f", "\u007f", "\u0080", "\u009f"])
      rejects(() => verify({ ...actor, sub: "synthetic" + sub }));
    for (const sub of ["žluťoučký kůň", "x".repeat(512)]) expect(verify({ ...actor, sub }).sub).toBe(sub);
  });

  it("binds exactly the actual request opaque ID with inclusive 32..128 bounds", () => {
    for (const id of ["a".repeat(32), "Z_9-".repeat(32)]) expect(verify({ ...actor, contributorIdDay: id }, now, id).contributorIdDay).toBe(id);
    for (const id of ["a".repeat(31), "a".repeat(129), "x".repeat(31) + "/", "x".repeat(31) + "=", "x".repeat(31) + " "])
      rejects(() => verify({ ...actor, contributorIdDay: id }, now, id));
    rejects(() => verify(actor, now, "z".repeat(43)));
  });

  it("rejects every missing field, unknown fields and non-object payloads", () => {
    for (const key of Object.keys(actor)) { const incomplete = { ...actor } as Record<string, unknown>; delete incomplete[key]; rejects(() => verify(incomplete)); }
    for (const value of [{ ...actor, extra: true }, { ...actor, __extra: "not accepted" }, [], [actor], null, true, "actor"])
      rejects(() => verify(value));
  });

  it("rejects reordered, spaced, duplicate and escaped JSON even with a correct HMAC", () => {
    const canonical = JSON.stringify(actor);
    const reversed = Object.fromEntries(Object.entries(actor).reverse());
    for (const text of [JSON.stringify(reversed), JSON.stringify(actor, null, 2), " " + canonical, canonical + "\n",
      canonical.replace('"sub":"synthetic-account"', '"sub":"synthetic-account","sub":"synthetic-account"'),
      canonical.replace('"iss"', '"\\u0069ss"'), canonical.replace("synthetic-account", "\\u0073ynthetic-account"),
      canonical.replace("https://", "https:\\/\\/")]) {
      const proof = encoded(text); rejects(() => verifyDriverRevocationActor(proof.header, proof.signature, secret, issuer, contributorIdDay, now));
    }
  });

  it("rejects noncanonical base64url and invalid UTF-8 without decoding replacement acceptance", () => {
    const proof = signed();
    for (const header of [proof.header + "=", proof.header + "\n", "not+base64/url", "", "a".repeat(2049)])
      rejects(() => verifyDriverRevocationActor(header, signature(header), secret, issuer, contributorIdDay, now));
    // ASCII JSON with a literal replacement character would be a different
    // claim. Signed ill-formed UTF-8 must not normalize into that claim.
    const invalid = Buffer.from(JSON.stringify({ ...actor, sub: "badX" })); invalid[invalid.indexOf(Buffer.from("badX")) + 3] = 0xff;
    const header = invalid.toString("base64url");
    rejects(() => verifyDriverRevocationActor(header, signature(header), secret, issuer, contributorIdDay, now));
    // Alter only non-significant final base64 bits while preserving the bytes.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const text = [actor.sub, actor.sub + "x", actor.sub + "xx"].map(sub => JSON.stringify({ ...actor, sub }))
      .find(value => Buffer.byteLength(value) % 3 !== 0)!;
    const h = Buffer.from(text).toString("base64url");
    expect(verifyDriverRevocationActor(h, signature(h), secret, issuer, contributorIdDay, now)).toEqual(JSON.parse(text));
    const index = alphabet.indexOf(h.at(-1)!); const variant = h.slice(0, -1) + alphabet[index ^ 1];
    expect(Buffer.from(variant, "base64url")).toEqual(Buffer.from(h, "base64url"));
    rejects(() => verifyDriverRevocationActor(variant, signature(variant), secret, issuer, contributorIdDay, now));
  });

  it("rejects tampering, wrong keys and malformed/missing signature/header/configuration", () => {
    const proof = signed(), altered = signed({ ...actor, sub: "another-synthetic-account" });
    for (const sig of [undefined, null, "", "0".repeat(63), "0".repeat(65), "g".repeat(64), proof.signature.toUpperCase(), "0".repeat(64), signature(proof.header, "different-synthetic-key-at-least-thirty-two")])
      rejects(() => verifyDriverRevocationActor(proof.header, sig, secret, issuer, contributorIdDay, now));
    rejects(() => verifyDriverRevocationActor(altered.header, proof.signature, secret, issuer, contributorIdDay, now));
    for (const header of [undefined, null, [], {}]) rejects(() => verifyDriverRevocationActor(header, proof.signature, secret, issuer, contributorIdDay, now));
    for (const key of [undefined, "", "x".repeat(31)]) rejects(() => verifyDriverRevocationActor(proof.header, proof.signature, key, issuer, contributorIdDay, now));
    for (const expectedIssuer of [undefined, "", "https://different.synthetic.invalid"]) rejects(() => verifyDriverRevocationActor(proof.header, proof.signature, secret, expectedIssuer, contributorIdDay, now));
    for (const clock of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER, 8_640_000_000_000_000])
      rejects(() => verifyDriverRevocationActor(proof.header, proof.signature, secret, issuer, contributorIdDay, clock));
  });
});
