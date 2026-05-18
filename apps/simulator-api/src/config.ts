import type { PublisherMode } from "@delta-acr/contracts";
import { DEFAULT_SOURCE_SYSTEM_ID } from "@delta-acr/contracts";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ApiConfig {
  port: number;
  dataDir: string;
  schemaDir: string;
  publisherMode: PublisherMode;
  sourceSystemId: string;
  adapterVersion: string;
  mainCopBaseUrl?: string;
  externalAiAllowed: boolean;
}

export async function loadConfig(): Promise<ApiConfig> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = resolve(process.env.SIM_DATA_DIR ?? `${projectRoot}/data`);
  await mkdir(dataDir, { recursive: true });

  return {
    port: Number(process.env.API_PORT ?? 4000),
    dataDir,
    schemaDir: resolve(process.env.SIM_SCHEMA_DIR ?? `${projectRoot}/docs/api/schemas`),
    publisherMode: parsePublisherMode(process.env.SIM_PUBLISHER_MODE),
    sourceSystemId: process.env.SIM_SOURCE_SYSTEM_ID ?? DEFAULT_SOURCE_SYSTEM_ID,
    adapterVersion: process.env.SIM_ADAPTER_VERSION ?? "0.1.0",
    mainCopBaseUrl: process.env.MAIN_COP_BASE_URL,
    externalAiAllowed: process.env.EXTERNAL_AI_ALLOWED === "true"
  };
}

function parsePublisherMode(value: string | undefined): PublisherMode {
  if (value === "MOCK" || value === "LIVE" || value === "DRY_RUN") {
    return value;
  }
  return "DRY_RUN";
}
