import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

export interface CopActor {
  sub: string;
  aud: "sim-ai-router";
  iat: number;
  exp: number;
}

const OPAQUE_USER = /^[A-Za-z0-9_-]{8,128}$/u;

export function verifyCopActor(req: Request, secret: string, now = Math.floor(Date.now() / 1000)): CopActor | null {
  if (secret.length < 32) return null;
  const encoded = req.header("x-cop-actor") ?? "";
  const signature = req.header("x-cop-actor-signature") ?? "";
  if (!/^[A-Za-z0-9_-]{20,512}$/u.test(encoded) || !/^[a-f0-9]{64}$/u.test(signature)) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest();
  const supplied = Buffer.from(signature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  let actor: unknown;
  try {
    actor = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) return null;
  const claim = actor as Record<string, unknown>;
  if (Object.keys(claim).length !== 4 || !["sub", "aud", "iat", "exp"].every((key) => Object.hasOwn(claim, key))) return null;
  if (typeof claim.sub !== "string" || !OPAQUE_USER.test(claim.sub) || claim.aud !== "sim-ai-router") return null;
  if (!Number.isSafeInteger(claim.iat) || !Number.isSafeInteger(claim.exp)) return null;
  const issued = claim.iat as number;
  const expires = claim.exp as number;
  if (issued > now + 5 || issued < now - 60 || expires <= now || expires - issued > 60) return null;
  return claim as unknown as CopActor;
}
