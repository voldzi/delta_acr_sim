import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoundingBox } from "./types.js";

export interface TakGatewayConfig {
  port: number;
  dataDir: string;
  ingestToken?: string;
  readToken?: string;
  publicRead: boolean;
  defaultBbox: BoundingBox;
  staleAfterSeconds: number;
  retentionSeconds: number;
  maxEvents: number;
  exposeRaw: boolean;
  sourceLabel: string;
  corsOrigins?: string[];
}

export async function loadConfig(): Promise<TakGatewayConfig> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = resolve(process.env.TAK_GATEWAY_DATA_DIR ?? `${projectRoot}/data/tak-gateway`);
  await mkdir(dataDir, { recursive: true });

  return {
    port: parseInteger(process.env.TAK_GATEWAY_API_PORT, 4040),
    dataDir,
    ingestToken: normalizeSecret(process.env.TAK_GATEWAY_INGEST_TOKEN),
    readToken: normalizeSecret(process.env.TAK_GATEWAY_READ_TOKEN),
    publicRead: parseBoolean(process.env.TAK_GATEWAY_PUBLIC_READ, false),
    defaultBbox: parseBbox(process.env.TAK_GATEWAY_DEFAULT_BBOX) ?? {
      west: 11.8,
      south: 48.5,
      east: 19.2,
      north: 51.2
    },
    staleAfterSeconds: parseInteger(process.env.TAK_GATEWAY_STALE_AFTER_SECONDS, 300),
    retentionSeconds: parseInteger(process.env.TAK_GATEWAY_RETENTION_SECONDS, 3600),
    maxEvents: parseInteger(process.env.TAK_GATEWAY_MAX_EVENTS, 5000),
    exposeRaw: parseBoolean(process.env.TAK_GATEWAY_EXPOSE_RAW),
    sourceLabel: process.env.TAK_GATEWAY_SOURCE_LABEL ?? "TAK/CoT gateway",
    corsOrigins: parseStringList(process.env.TAK_GATEWAY_CORS_ORIGINS)
  };
}

function normalizeSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBbox(value: string | undefined): BoundingBox | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }
  const [west, south, east, north] = parts as [number, number, number, number];
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
    return undefined;
  }
  return { west, south, east, north };
}

function parseStringList(value: string | undefined, fallback: string[] = []): string[] {
  const parsed = value
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return parsed && parsed.length > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === "1" || value === "true" || value === "yes";
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}
