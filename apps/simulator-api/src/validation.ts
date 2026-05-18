import type { ValidateFunction } from "ajv";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (options?: Record<string, unknown>) => {
  addSchema: (schema: object) => void;
  getSchema: (keyRef: string) => ValidateFunction | undefined;
  compile: (schema: object) => ValidateFunction;
};
const addFormats = require("ajv-formats").default as (ajv: unknown) => void;

export interface ValidationIssue {
  instancePath: string;
  message: string;
  keyword: string;
}

export interface Validators {
  scenario: ValidateFunction;
  fault: ValidateFunction;
  publisherConfig: ValidateFunction;
  canonicalEvent: ValidateFunction;
  aiDraft: ValidateFunction;
  issues: (validator: ValidateFunction) => ValidationIssue[];
}

export function createValidators(schemaDir: string): Validators {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);

  const schemaNames = [
    "scenario-block.schema.json",
    "fault-injection.schema.json",
    "publisher-config.schema.json",
    "canonical-event-envelope.schema.json",
    "simulator-event.schema.json",
    "ai-scenario-draft.schema.json",
    "scenario.schema.json"
  ];

  for (const name of schemaNames) {
    const schema = JSON.parse(readFileSync(join(schemaDir, name), "utf8")) as object;
    ajv.addSchema(schema);
  }

  const scenario = ajv.getSchema("https://example.local/sim/scenario.schema.json") ?? ajv.compile(JSON.parse(readFileSync(join(schemaDir, "scenario.schema.json"), "utf8")));
  const fault = ajv.getSchema("https://example.local/sim/fault-injection.schema.json") ?? ajv.compile(JSON.parse(readFileSync(join(schemaDir, "fault-injection.schema.json"), "utf8")));
  const publisherConfig = ajv.getSchema("https://example.local/sim/publisher-config.schema.json") ?? ajv.compile(JSON.parse(readFileSync(join(schemaDir, "publisher-config.schema.json"), "utf8")));
  const canonicalEvent = ajv.getSchema("https://example.local/sim/canonical-event-envelope.schema.json") ?? ajv.compile(JSON.parse(readFileSync(join(schemaDir, "canonical-event-envelope.schema.json"), "utf8")));
  const aiDraft = ajv.getSchema("https://example.local/sim/ai-scenario-draft.schema.json") ?? ajv.compile(JSON.parse(readFileSync(join(schemaDir, "ai-scenario-draft.schema.json"), "utf8")));

  return {
    scenario,
    fault,
    publisherConfig,
    canonicalEvent,
    aiDraft,
    issues: (validator) =>
      (validator.errors ?? []).map((error) => ({
        instancePath: error.instancePath,
        message: error.message ?? "Validation error",
        keyword: error.keyword
      }))
  };
}
