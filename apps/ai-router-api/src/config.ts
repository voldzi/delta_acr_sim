export interface Config {
  port: number;
  databaseUrl: string;
  copToken: string;
  simToken: string;
  adminToken: string;
  userHashSecret: string;
  openaiKey: string;
  externalEnabled: boolean;
  copInternalMinimizedEnabled: boolean;
  advancedEnabled: boolean;
  localUrl: string;
  localUrls?: string[];
  localModel: string;
  economyModel: string;
  advancedModel: string;
  dailyMicrousd: number;
  monthlyMicrousd: number;
  perUserDailyRequests: number;
  copActorSecret?: string;
  credentialEncryptionKey?: string;
  copByokEnabled?: boolean;
  simIzsEnabled?: boolean;
  izsToken?: string;
  simIzsOpenaiKey?: string;
  simIzsModel?: string;
  simIzsProjectId?: string;
  byokDailyMicrousd?: number;
  byokMonthlyMicrousd?: number;
  byokDailyRequests?: number;
  simIzsDailyMicrousd?: number;
  simIzsMonthlyMicrousd?: number;
  simIzsDailyRequests?: number;
  publishedSourceIds?: string[];
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig(): Config {
  const databaseUrl = process.env.AI_ROUTER_DATABASE_URL ?? "";
  if (!/^postgres(?:ql)?:\/\//u.test(databaseUrl)) throw new Error("AI_ROUTER_DATABASE_URL must be a PostgreSQL URL");
  const required = (name: string) => {
    const value = process.env[name];
    if (!value || value.length < 24) throw new Error(`${name} must be set to a high-entropy value`);
    return value;
  };
  const copToken = required("AI_ROUTER_COP_TOKEN");
  const simToken = required("AI_ROUTER_SIM_TOKEN");
  const adminToken = required("AI_ROUTER_ADMIN_TOKEN");
  if (new Set([copToken, simToken, adminToken]).size !== 3) throw new Error("AI Router service tokens must be distinct");
  const copByokEnabled = process.env.AI_ROUTER_COP_BYOK_ENABLED === "true";
  const simIzsEnabled = process.env.AI_ROUTER_SIM_IZS_ENABLED === "true";
  const izsToken = process.env.AI_ROUTER_IZS_TOKEN ?? "";
  const copActorSecret = process.env.AI_ROUTER_COP_ACTOR_SECRET ?? "";
  const credentialEncryptionKey = process.env.AI_ROUTER_CREDENTIAL_ENCRYPTION_KEY ?? "";
  if (copByokEnabled && copActorSecret.length < 32) {
    throw new Error("COP BYOK requires a separate actor secret");
  }
  if ((copByokEnabled || simIzsEnabled) && Buffer.from(credentialEncryptionKey, "base64").length !== 32) {
    throw new Error("Separate billing requires a 32-byte credential encryption key");
  }
  if (simIzsEnabled && (izsToken.length < 24 || new Set([copToken, simToken, adminToken]).has(izsToken))) {
    throw new Error("SIM IZS requires a distinct high-entropy service token");
  }
  if (simIzsEnabled && (!process.env.AI_ROUTER_SIM_IZS_PROJECT_ID ||
      process.env.AI_ROUTER_SIM_IZS_BUDGET_APPROVED !== "true")) {
    throw new Error("SIM IZS requires an explicit project ID and approved paid daily/monthly budget");
  }
  return {
    port: positiveInt("AI_ROUTER_PORT", 4050),
    databaseUrl,
    copToken,
    simToken,
    adminToken,
    userHashSecret: required("AI_ROUTER_USER_HASH_SECRET"),
    openaiKey: process.env.OPENAI_API_KEY ?? "",
    externalEnabled: process.env.AI_ROUTER_EXTERNAL_ENABLED === "true",
    copInternalMinimizedEnabled: process.env.AI_ROUTER_COP_INTERNAL_MINIMIZED_ENABLED === "true",
    advancedEnabled: process.env.AI_ROUTER_ADVANCED_ENABLED === "true",
    localUrl: process.env.AI_ROUTER_LOCAL_URL ?? "",
    localUrls: (process.env.AI_ROUTER_LOCAL_URLS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    localModel: process.env.AI_ROUTER_LOCAL_MODEL ?? "",
    economyModel: process.env.AI_ROUTER_ECONOMY_MODEL ?? "gpt-6-luna",
    advancedModel: process.env.AI_ROUTER_ADVANCED_MODEL ?? "gpt-6-sol",
    dailyMicrousd: positiveInt("AI_ROUTER_DAILY_MICROUSD", 1_000_000),
    monthlyMicrousd: positiveInt("AI_ROUTER_MONTHLY_MICROUSD", 10_000_000),
    perUserDailyRequests: positiveInt("AI_ROUTER_USER_DAILY_REQUESTS", 10),
    copActorSecret,
    credentialEncryptionKey,
    copByokEnabled,
    simIzsEnabled,
    izsToken,
    simIzsOpenaiKey: process.env.AI_ROUTER_SIM_IZS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "",
    simIzsModel: process.env.AI_ROUTER_SIM_IZS_MODEL ?? "gpt-5.4-mini",
    simIzsProjectId: process.env.AI_ROUTER_SIM_IZS_PROJECT_ID ?? "",
    byokDailyMicrousd: positiveInt("AI_ROUTER_BYOK_DAILY_MICROUSD", 1_000_000),
    byokMonthlyMicrousd: positiveInt("AI_ROUTER_BYOK_MONTHLY_MICROUSD", 10_000_000),
    byokDailyRequests: positiveInt("AI_ROUTER_BYOK_DAILY_REQUESTS", 10),
    simIzsDailyMicrousd: positiveInt("AI_ROUTER_SIM_IZS_DAILY_MICROUSD", 1_000_000),
    simIzsMonthlyMicrousd: positiveInt("AI_ROUTER_SIM_IZS_MONTHLY_MICROUSD", 10_000_000),
    simIzsDailyRequests: positiveInt("AI_ROUTER_SIM_IZS_DAILY_REQUESTS", 20),
    publishedSourceIds: (process.env.AI_ROUTER_PUBLISHED_SOURCE_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean)
  };
}
