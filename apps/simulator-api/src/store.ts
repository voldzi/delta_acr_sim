import type { AiScenarioDraft, RuntimeStatus, Scenario } from "@csm-sim/contracts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AppData {
  scenarios: Scenario[];
  drafts: AiScenarioDraft[];
  runtime: RuntimeStatus;
  aiConfig: {
    providerMode: "openai" | "codex" | "local" | "mock" | "auto";
    externalProviderAllowed: boolean;
  };
}

const initialData: AppData = {
  scenarios: [],
  drafts: [],
  runtime: {
    state: "STOPPED",
    generatedEvents: 0,
    publishedEvents: 0,
    queuedEvents: 0
  },
  aiConfig: {
    providerMode: "mock",
    externalProviderAllowed: false
  }
};

export class JsonStore {
  data: AppData = structuredClone(initialData);

  constructor(private readonly storePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.storePath, "utf8");
      this.data = { ...structuredClone(initialData), ...(JSON.parse(raw) as Partial<AppData>) };
    } catch {
      this.data = structuredClone(initialData);
      await this.save();
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify(this.data, null, 2), "utf8");
  }
}
