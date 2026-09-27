type Json = Record<string, unknown>;

const UNITS = new Set(["count", "percent", "minutes", "km", "index"]);
const STATUSES = new Set(["up", "degraded", "down"]);
const ORIGINS = new Set(["official", "licensed_public", "sim_published"]);
const CODE = /^[A-Za-z0-9_.-]{1,64}$/u;
const REGION = /^CZ(?:\d{3})?$/u;

function record(value: unknown): value is Json {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exact(value: Json, required: string[], optional: string[] = []): boolean {
  const actual = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && actual.every((key) => required.includes(key) || optional.includes(key));
}

function date(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) return NaN;
  return Date.parse(value);
}

function publishedItem(value: unknown, sourceIds: string[], now: number): value is Json {
  if (!record(value)) return false;
  const common = ["kind", "sourceId", "publicationStatus", "originType", "publicationRef", "observedAt", "publishedAt", "validUntil"];
  const extra = value.kind === "source_health" ? ["status"] : value.kind === "operational_metric"
    ? ["metricId", "regionCode", "value", "unit", "sampleSize"] : [];
  if (extra.length === 0 || !exact(value, [...common, ...extra])) return false;
  const observed = date(value.observedAt);
  const published = date(value.publishedAt);
  const validUntil = date(value.validUntil);
  if (!CODE.test(String(value.sourceId)) || !sourceIds.includes(String(value.sourceId)) ||
      value.publicationStatus !== "published" || !ORIGINS.has(String(value.originType)) ||
      !CODE.test(String(value.publicationRef)) || !Number.isFinite(observed) || !Number.isFinite(published) ||
      !Number.isFinite(validUntil) || observed > published || published > now || validUntil <= now ||
      validUntil - observed > 30 * 86_400_000) return false;
  if (value.kind === "source_health") return STATUSES.has(String(value.status));
  return CODE.test(String(value.metricId)) && REGION.test(String(value.regionCode)) &&
    typeof value.value === "number" && Number.isFinite(value.value) && UNITS.has(String(value.unit)) &&
    Number.isSafeInteger(value.sampleSize) && (value.sampleSize as number) >= 10;
}

export function validPublishedContext(value: unknown, attestation: string, sourceIds: string[], now = Date.now()): value is Json {
  if (!record(value) || !exact(value, ["contractVersion", "attestation", "items"])) return false;
  return value.contractVersion === "published-context-v1" && value.attestation === attestation &&
    Array.isArray(value.items) && value.items.length <= 12 && value.items.every((item) => publishedItem(item, sourceIds, now));
}

export interface CopChatBody {
  contractVersion: "cop-chat-byok-v1";
  billingSource: "user_openai_key";
  question: string;
  allowExternal: true;
  automaticContext?: Json;
  maxOutputTokens?: number;
}

export function validCopChatBody(value: unknown, sourceIds: string[]): value is CopChatBody {
  if (!record(value) || !exact(value, ["contractVersion", "billingSource", "question", "allowExternal"], ["automaticContext", "maxOutputTokens"])) return false;
  return value.contractVersion === "cop-chat-byok-v1" && value.billingSource === "user_openai_key" &&
    value.allowExternal === true && typeof value.question === "string" && value.question.trim().length > 0 &&
    value.question.length <= 1200 && (value.automaticContext === undefined ||
      validPublishedContext(value.automaticContext, "cop-published-reviewed-v1", sourceIds)) &&
    (value.maxOutputTokens === undefined || Number.isSafeInteger(value.maxOutputTokens) && (value.maxOutputTokens as number) >= 1 && (value.maxOutputTokens as number) <= 1024);
}

export interface SimIzsBody {
  contractVersion: "sim-izs-summary-v1";
  billingSource: "sim_project";
  taskType: "sim_izs_summary";
  dataClass: "synthetic" | "public_aggregate";
  prompt: string;
  context: Json;
  maxOutputTokens?: number;
}

export function validSimIzsBody(value: unknown, sourceIds: string[]): value is SimIzsBody {
  if (!record(value) || !exact(value, ["contractVersion", "billingSource", "taskType", "dataClass", "prompt", "context"], ["maxOutputTokens"])) return false;
  if (value.contractVersion !== "sim-izs-summary-v1" || value.billingSource !== "sim_project" || value.taskType !== "sim_izs_summary" ||
      typeof value.prompt !== "string" || value.prompt.trim().length < 1 || value.prompt.length > 2000 ||
      (value.maxOutputTokens !== undefined && (!Number.isSafeInteger(value.maxOutputTokens) || (value.maxOutputTokens as number) < 1 || (value.maxOutputTokens as number) > 1024))) return false;
  if (value.dataClass === "public_aggregate") return validPublishedContext(value.context, "sim-published-reviewed-v1", sourceIds);
  const context = value.context;
  return value.dataClass === "synthetic" && record(context) && exact(context, ["contractVersion", "attestation", "facts"]) &&
    context.contractVersion === "sim-synthetic-context-v1" && context.attestation === "sim-synthetic-reviewed-v1" &&
    Array.isArray(context.facts) && context.facts.length >= 1 && context.facts.length <= 12 &&
    context.facts.every((fact) => typeof fact === "string" && fact.trim().length > 0 && fact.length <= 240);
}

export function copOutboundInput(body: CopChatBody): string {
  const header = "Odpověz česky jako civilní asistent. Uživatelem napsaná otázka není ověřeným hlášením. Nevydávej operační rozhodnutí; vyznač nejistotu a stáří podkladů.";
  const context = body.automaticContext ? `\nOvěřený zveřejněný strukturovaný kontext COP:\n${JSON.stringify(body.automaticContext.items)}` : "";
  return `${header}\nOtázka napsaná uživatelem:\n${body.question}${context}`;
}

export function simIzsOutboundInput(body: SimIzsBody): string {
  return `Vytvoř pouze návrh civilního souhrnu pro lidské posouzení, ne ověřenou krizovou událost ani pokyn k zásahu. Vyznač původ, stáří a nejistotu.\nZadání SIM:\n${body.prompt}\nPovolené ${body.dataClass} podklady:\n${JSON.stringify(body.context)}`;
}
