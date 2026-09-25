import type { DataClass } from "./routing.js";

type JsonObject = Record<string, unknown>;

const VERSION = "cop-chat-context-v1";
const ATTESTATION = "cop-policy-reviewed-v1";
const AGGREGATE_UNITS = new Set(["count", "percent", "minutes", "km", "index"]);

function record(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: JsonObject, required: string[]): boolean {
  return Object.keys(value).length === required.length && required.every((key) => Object.hasOwn(value, key));
}

function code(value: unknown, max = 64): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[a-zA-Z0-9_.-]+$/u.test(value);
}

function timestamp(value: unknown): number {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    ? Date.parse(value)
    : NaN;
}

function aggregate(value: unknown): value is JsonObject {
  if (!record(value) || !exactKeys(value, ["sourceId", "metricId", "regionCode", "periodStart", "periodEnd", "value", "unit", "sampleSize"])) return false;
  const start = timestamp(value.periodStart);
  const end = timestamp(value.periodEnd);
  return code(value.sourceId) && code(value.metricId) &&
    typeof value.regionCode === "string" && /^CZ(?:\d{3})?$/u.test(value.regionCode) &&
    Number.isFinite(start) && Number.isFinite(end) && end - start >= 3_600_000 &&
    typeof value.value === "number" && Number.isFinite(value.value) &&
    typeof value.unit === "string" && AGGREGATE_UNITS.has(value.unit) &&
    typeof value.sampleSize === "number" && Number.isSafeInteger(value.sampleSize) && value.sampleSize >= 10;
}

export function validCopContext(value: unknown, dataClass: DataClass): boolean {
  if (!record(value) || value.contractVersion !== VERSION || value.dataClass !== dataClass) return false;
  if (dataClass === "internal") return exactKeys(value, ["contractVersion", "dataClass"]);
  if (value.attestation !== ATTESTATION) return false;
  if (dataClass === "synthetic") {
    return exactKeys(value, ["contractVersion", "dataClass", "attestation", "scenarioId", "facts"]) &&
      code(value.scenarioId) && Array.isArray(value.facts) && value.facts.length >= 1 && value.facts.length <= 12 &&
      value.facts.every((fact: unknown) => typeof fact === "string" && fact.trim().length > 0 && fact.length <= 240);
  }
  return exactKeys(value, ["contractVersion", "dataClass", "attestation", "aggregates"]) &&
    Array.isArray(value.aggregates) && value.aggregates.length >= 1 && value.aggregates.length <= 20 &&
    value.aggregates.every(aggregate);
}

export function copModelPrompt(question: string, context: JsonObject): string {
  if (context.dataClass === "internal") return question;
  return `Question from COP (reviewed for this data class):\n${question}\n\nCOP context (${context.dataClass}):\n${JSON.stringify(context.dataClass === "synthetic" ? { scenarioId: context.scenarioId, facts: context.facts } : { aggregates: context.aggregates })}`;
}
