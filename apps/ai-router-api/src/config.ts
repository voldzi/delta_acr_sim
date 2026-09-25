export interface Config {
  port: number;
  databaseUrl: string;
  copToken: string;
  simToken: string;
  adminToken: string;
  userHashSecret: string;
  openaiKey: string;
  externalEnabled: boolean;
  advancedEnabled: boolean;
  localUrl: string;
  localModel: string;
  economyModel: string;
  advancedModel: string;
  dailyMicrousd: number;
  monthlyMicrousd: number;
  perUserDailyRequests: number;
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
  return {
    port: positiveInt("AI_ROUTER_PORT", 4050),
    databaseUrl,
    copToken,
    simToken,
    adminToken,
    userHashSecret: required("AI_ROUTER_USER_HASH_SECRET"),
    openaiKey: process.env.OPENAI_API_KEY ?? "",
    externalEnabled: process.env.AI_ROUTER_EXTERNAL_ENABLED === "true",
    advancedEnabled: process.env.AI_ROUTER_ADVANCED_ENABLED === "true",
    localUrl: process.env.AI_ROUTER_LOCAL_URL ?? "",
    localModel: process.env.AI_ROUTER_LOCAL_MODEL ?? "",
    economyModel: process.env.AI_ROUTER_ECONOMY_MODEL ?? "gpt-6-luna",
    advancedModel: process.env.AI_ROUTER_ADVANCED_MODEL ?? "gpt-6-sol",
    dailyMicrousd: positiveInt("AI_ROUTER_DAILY_MICROUSD", 1_000_000),
    monthlyMicrousd: positiveInt("AI_ROUTER_MONTHLY_MICROUSD", 10_000_000),
    perUserDailyRequests: positiveInt("AI_ROUTER_USER_DAILY_REQUESTS", 10)
  };
}
