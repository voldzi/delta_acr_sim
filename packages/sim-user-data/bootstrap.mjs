/** Concrete future production bootstrap. No auto-enrollment or external module.
 * All admissions come from the independent SQL factory shipped in this image. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createSimUserDataAuthority } from "./authority.mjs";
import { attachSimPgErrorObservers } from "./pg-errors.mjs";
import { verifyProductionDatabaseTransport } from "../../deploy/account-safety/database-erasure-guard.mjs";
export function runtimeIdentityFingerprint(component, identity) {
  const fields =
    component === "sim_user_data"
      ? ["ownerSecret", "actorSecret", "routerActorSecret", "issuer"]
      : component === "sim_user_history"
        ? ["hashSecret", "actorSecret", "issuer"]
        : [];
  if (
    !fields.length ||
    !identity ||
    Object.keys(identity).length !== fields.length ||
    !fields.every((k) => typeof identity[k] === "string" && (k === "issuer" ? identity[k].startsWith("https://") : identity[k].length >= 32))
  )
    throw Error("SIM_USER_RUNTIME_IDENTITY_REQUIRED");
  return createHash("sha256")
    .update(JSON.stringify({ contract: "sim-user-runtime-identity-v1", component, ...Object.fromEntries(fields.map((k) => [k, identity[k]])) }))
    .digest("hex");
}
export async function loadSimUserAuthority({ Pool, targetPool, targetDatabaseUrl, component, settings, identity, env = process.env }) {
  if (settings.mode !== "production-sim-user-data-v1") return undefined;
  const name = component === "sim_user_data" ? "SIM_USER_DATA" : "SIM_USER_HISTORY";
  const url = env[name + "_GUARD_DATABASE_URL"];
  const binding = JSON.parse(env[name + "_CONTINUITY_BINDING"] ?? "null");
  const source = createHash("sha256")
    .update(await readFile(new URL("./authority.mjs", import.meta.url)))
    .digest("hex");
  if (
    !binding ||
    binding.source_sha256 !== source ||
    binding.identity_sha256 !== runtimeIdentityFingerprint(component, identity) ||
    binding.environment_id !== settings.environmentId ||
    binding.reset_epoch !== settings.resetEpoch
  )
    throw Error("SIM_USER_CONTINUITY_SOURCE_REQUIRED");
  verifyProductionDatabaseTransport(url, "cop_account_safety_guard", { ...env, NODE_ENV: "production" });
  verifyProductionDatabaseTransport(targetDatabaseUrl, component === "sim_user_data" ? "sim_user_data" : "sim_ai_router", { ...env, NODE_ENV: "production" });
  const guardPool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 2000, statement_timeout: 10000 });
  if (component === "sim_user_data") attachSimPgErrorObservers(guardPool, "guard");
  else guardPool.on("error", () => {});
  try {
    const authority = await createSimUserDataAuthority({ guardPool, targetPool, component, binding });
    return { authority, close: () => guardPool.end() };
  } catch {
    await guardPool.end();
    throw Error("SIM_USER_CONTINUITY_UNAVAILABLE");
  }
}
