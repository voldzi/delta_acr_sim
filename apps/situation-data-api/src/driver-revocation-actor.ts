import { createHmac, timingSafeEqual } from "node:crypto";

export type DriverRevocationActorSource = "verified_session" | "consent_ledger";
export interface DriverRevocationActor {
  readonly iss: string;
  readonly sub: string;
  readonly aud: "sim-driver-revocation";
  readonly iat: number;
  readonly exp: number;
  readonly contributorDay: string;
  readonly contributorIdDay: string;
  readonly actorSource: DriverRevocationActorSource;
}
export class DriverRevocationActorError extends Error {
  readonly status = 401;
  readonly code = "DRIVER_REVOCATION_ACTOR_INVALID";
  constructor() { super("DRIVER_REVOCATION_ACTOR_INVALID"); this.name = "DriverRevocationActorError"; }
}

const KEYS = ["iss", "sub", "aud", "iat", "exp", "contributorDay", "contributorIdDay", "actorSource"] as const;
const OPAQUE = /^[A-Za-z0-9_-]{32,128}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const denied = (): never => { throw new DriverRevocationActorError(); };

/**
 * Verifies only the exact local signed claim. This is NOT Root daily-ID
 * derivation, verified consent, identity binding, a lease or mutation authority.
 * Canonical compact JSON/order rejects duplicate keys and escaped variants.
 * now is milliseconds, while the signed iat/exp fields are integer seconds.
 */
export function verifyDriverRevocationActor(
  header: unknown,
  signature: unknown,
  secret: string | undefined,
  issuer: string | undefined,
  contributorIdDay: string,
  now: number
): DriverRevocationActor {
  if (typeof secret !== "string" || secret.length < 32 || typeof issuer !== "string" || !issuer ||
    typeof header !== "string" || !/^[A-Za-z0-9_-]{20,2048}$/u.test(header) ||
    typeof signature !== "string" || !/^[a-f0-9]{64}$/u.test(signature) ||
    typeof contributorIdDay !== "string" || !OPAQUE.test(contributorIdDay) ||
    typeof now !== "number" || !Number.isFinite(now) || now < 0) return denied();
  if (!timingSafeEqual(createHmac("sha256", secret).update(header).digest(), Buffer.from(signature, "hex"))) return denied();

  let raw: Record<string, unknown>, latestDay: string;
  const current = Math.floor(now / 1000);
  try {
    const bytes = Buffer.from(header, "base64url"), text = bytes.toString("utf8");
    if (bytes.toString("base64url") !== header || !bytes.equals(Buffer.from(text, "utf8"))) return denied();
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return denied();
    raw = parsed as Record<string, unknown>;
    if (Object.keys(raw).join(",") !== KEYS.join(",") || JSON.stringify(raw) !== text) return denied();
    // An invalid/overflowed clock must fail closed, never wrap the tolerated day.
    latestDay = new Date(now + 30_000).toISOString().slice(0, 10);
    if (!Number.isSafeInteger(current) || !DAY.test(latestDay)) return denied();
  } catch { return denied(); }

  if (raw.iss !== issuer || raw.aud !== "sim-driver-revocation" ||
    typeof raw.sub !== "string" || raw.sub.length < 1 || raw.sub.length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(raw.sub) ||
    typeof raw.iat !== "number" || typeof raw.exp !== "number" || !Number.isSafeInteger(raw.iat) || !Number.isSafeInteger(raw.exp) ||
    raw.iat < 0 || raw.iat > current || raw.exp <= current || raw.exp <= raw.iat || raw.exp - raw.iat > 60 ||
    typeof raw.contributorDay !== "string" || !DAY.test(raw.contributorDay) ||
    !Number.isFinite(Date.parse(`${raw.contributorDay}T00:00:00Z`)) ||
    new Date(`${raw.contributorDay}T00:00:00Z`).toISOString().slice(0, 10) !== raw.contributorDay || raw.contributorDay > latestDay ||
    typeof raw.contributorIdDay !== "string" || raw.contributorIdDay !== contributorIdDay || !OPAQUE.test(raw.contributorIdDay) ||
    (raw.actorSource !== "verified_session" && raw.actorSource !== "consent_ledger")) return denied();

  return Object.freeze(raw) as unknown as DriverRevocationActor;
}
