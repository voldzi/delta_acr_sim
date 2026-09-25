export type DataClass = "synthetic" | "public_aggregate" | "internal";
export type TaskType = "cop_chat" | "source_health" | "sim_scenario";
export type ModelPreference = "auto" | "local" | "external";
export type ModelTier = "local_fast" | "external_economy" | "external_advanced";

export interface RoutingInput {
  taskType: TaskType;
  dataClass: DataClass;
  preference: ModelPreference;
  prompt: string;
  allowExternal: boolean;
  allowPaidEscalation: boolean;
}

export interface RoutingPolicy {
  localAvailable: boolean;
  externalAvailable: boolean;
  advancedAvailable: boolean;
  externalEnabled: boolean;
}

export interface RoutingDecision {
  tier: ModelTier;
  difficulty: "simple" | "complex";
  reason: string;
}

export function taskAllowsDataClass(taskType: TaskType, dataClass: DataClass): boolean {
  if (taskType === "source_health") return dataClass === "public_aggregate";
  if (taskType === "sim_scenario") return dataClass === "synthetic";
  return true;
}

// This classifier is deliberately deterministic and cheap. The caller may not
// turn a sensitive data class into an external call by requesting a model.
export function classifyDifficulty(input: Pick<RoutingInput, "taskType" | "prompt">): "simple" | "complex" {
  if (input.taskType === "sim_scenario") return "complex";
  if (input.prompt.length > 2200) return "complex";
  if (/\b(compare|conflict|causal|reasoning|porovnej|rozpor|příčin|analyzuj)\b/iu.test(input.prompt)) return "complex";
  return "simple";
}

export function chooseRoute(input: RoutingInput, policy: RoutingPolicy): RoutingDecision {
  const difficulty = classifyDifficulty(input);
  if (input.taskType === "cop_chat") {
    if (input.dataClass === "internal" || input.preference === "local" || !input.allowExternal) {
      if (!policy.localAvailable) throw new Error("local_model_unavailable");
      return { tier: "local_fast", difficulty, reason: "local_only_policy" };
    }
    if (input.preference === "auto" && difficulty === "simple" && policy.localAvailable) {
      return { tier: "local_fast", difficulty, reason: "simple_local_first" };
    }
    if (policy.externalEnabled && policy.externalAvailable) {
      return { tier: "external_economy", difficulty, reason: "approved_cop_external_economy" };
    }
    if (input.preference === "external" || !policy.localAvailable) throw new Error("external_model_unavailable");
    return { tier: "local_fast", difficulty, reason: "external_disabled_local_only" };
  }
  if (input.preference === "local" || input.dataClass === "internal" || !input.allowExternal || !policy.externalEnabled) {
    if (!policy.localAvailable) throw new Error("local_model_unavailable");
    return { tier: "local_fast", difficulty, reason: "local_only_policy" };
  }

  if (input.preference === "external" && !policy.externalAvailable) throw new Error("external_model_unavailable");
  if (input.preference === "auto" && difficulty === "simple" && policy.localAvailable) {
    return { tier: "local_fast", difficulty, reason: "simple_local_first" };
  }

  if (difficulty === "complex" && input.allowPaidEscalation && policy.advancedAvailable) {
    return { tier: "external_advanced", difficulty, reason: "explicit_advanced_escalation" };
  }
  if (policy.externalAvailable) return { tier: "external_economy", difficulty, reason: "approved_external_economy" };
  if (policy.localAvailable) return { tier: "local_fast", difficulty, reason: "external_unavailable_local_fallback" };
  throw new Error("no_model_available");
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3));
}

export function estimateMicrousd(inputTokens: number, outputTokens: number, inputUsdPerMillion: number, outputUsdPerMillion: number): number {
  return Math.ceil(inputTokens * inputUsdPerMillion + outputTokens * outputUsdPerMillion);
}
