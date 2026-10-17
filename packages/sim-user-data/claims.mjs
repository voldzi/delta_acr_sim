import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
export const SIM_USER_DATA_CONTRACT = "cop-sim-user-data-v1";
export const SIM_USER_SCOPE = "cop_sim_shared_identity_v1";
export function canonicalOwnerKey(secret, identity) {
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    !identity ||
    !/^https:\/\/[^\s]+$/.test(identity.issuer) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(identity.subject)
  )
    throw Error("SIM_CANONICAL_OWNER_REQUIRED");
  return createHmac("sha256", secret)
    .update("sim-user-owner-v1\0" + identity.issuer + "\0" + identity.subject)
    .digest("hex");
}
export function simOwnerAlias(owner) {
  if (!/^[a-f0-9]{64}$/.test(owner)) throw Error("SIM_OWNER_INVALID");
  return "sim_" + owner;
}
export function signSimOwner(secret, { ownerKey, resetEpoch, oidcIat, operationId, requestedAt }, now = Math.floor(Date.now() / 1000)) {
  const value = {
    iss: "sim-app",
    aud: "sim-user-history-v1",
    ownerKey,
    resetEpoch,
    oidcIat,
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
    ...(operationId === undefined ? {} : { operationId, requestedAt })
  };
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  return { "x-sim-user-actor": encoded, "x-sim-user-actor-signature": createHmac("sha256", secret).update(encoded).digest("hex") };
}
export function verifySimOwner(req, { secret, resetEpoch, tokensNotBefore }, now = Math.floor(Date.now() / 1000)) {
  const encoded = req.header("x-sim-user-actor") ?? "",
    signature = req.header("x-sim-user-actor-signature") ?? "";
  if (typeof secret !== "string" || secret.length < 32 || !/^[-_a-zA-Z0-9]{20,2048}$/.test(encoded) || !/^[a-f0-9]{64}$/.test(signature)) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return null;
  try {
    const x = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const optional = Object.hasOwn(x, "operationId");
    if (
      Object.keys(x).length !== (optional ? 10 : 8) ||
      !["iss", "aud", "ownerKey", "resetEpoch", "oidcIat", "iat", "exp", "jti", ...(optional ? ["operationId", "requestedAt"] : [])].every((k) =>
        Object.hasOwn(x, k)
      ) ||
      Buffer.from(JSON.stringify(x)).toString("base64url") !== encoded ||
      x.iss !== "sim-app" ||
      x.aud !== "sim-user-history-v1" ||
      !/^[a-f0-9]{64}$/.test(x.ownerKey) ||
      x.resetEpoch !== resetEpoch ||
      !Number.isSafeInteger(x.oidcIat) ||
      x.oidcIat <= tokensNotBefore ||
      x.oidcIat > now ||
      !Number.isSafeInteger(x.iat) ||
      x.iat > now ||
      x.iat < now - 60 ||
      !Number.isSafeInteger(x.exp) ||
      x.exp <= now ||
      x.exp <= x.iat ||
      x.exp - x.iat > 60 ||
      !/^[0-9a-f-]{36}$/.test(x.jti) ||
      (optional &&
        (!/^[0-9a-f-]{36}$/.test(x.operationId) ||
          typeof x.requestedAt !== "string" ||
          !Number.isFinite(Date.parse(x.requestedAt)) ||
          new Date(x.requestedAt).toISOString() !== x.requestedAt))
    )
      return null;
    return x;
  } catch {
    return null;
  }
}
