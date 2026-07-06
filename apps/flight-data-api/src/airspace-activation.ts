import type { FlightDataConfig } from "./config.js";
import { geometryIntersectsBbox } from "./geojson.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { BoundingBox, GeoJsonGeometry } from "./types.js";
import type { LoadedUasGeozones, UasGeozoneService } from "./uas-geozones.js";

const PROVIDER_ID = "sim.flight-data" as const;
const PROVIDER_LAYER_ID = "flight.airspace_activation" as const;
const CATALOG_LAYER_ID = "flight.airspace.activation" as const;

export interface AirspaceActivationQuery {
  bbox?: BoundingBox;
  limit: number;
  includeCancelled: boolean;
}

export interface AirspaceActivationFeatureCollection {
  type: "FeatureCollection";
  contractVersion: "flight-airspace-activation-v1";
  generatedAt: string;
  features: AirspaceActivationFeature[];
  source: {
    sourceId: "czech_aup_uup";
    label: string;
    baseUrl: string;
    loadedAt: string;
    validFrom?: string;
    validTo?: string;
    warnings: string[];
  };
  summary: {
    activationCount: number;
    returnedActivations: number;
    cancelledCount: number;
    withGeometryCount: number;
    notForNavigation: true;
  };
  warnings: string[];
}

export interface AirspaceActivationFeature {
  type: "Feature";
  id: string;
  geometry: GeoJsonGeometry;
  properties: {
    layerId: typeof CATALOG_LAYER_ID;
    providerId: typeof PROVIDER_ID;
    providerLayerId: typeof PROVIDER_LAYER_ID;
    sourceId: "czech_aup_uup";
    category: "airspace_activation";
    label: string;
    observedAt: string;
    stale: boolean;
    confidence: number;
    severity: "info" | "warning";
    designator: string;
    normalizedDesignator: string;
    lowerLimit: string;
    upperLimit: string;
    activationFrom: string;
    activationTo: string;
    status: "planned" | "updated" | "cancelled";
    responsibleUnit?: string;
    activity?: string;
    notForNavigation: true;
    providerProperties: {
      sourceDocument: "AUP" | "UUP";
      sourceUrl: string;
      matchedGeozoneIdent: string;
      matchedGeozonePublication: string;
    };
  };
}

interface LoadedActivations {
  activations: AirspaceActivationRecord[];
  loadedAt: string;
  validFrom?: string;
  validTo?: string;
  warnings: string[];
}

interface AirspaceActivationRecord {
  id: string;
  designator: string;
  normalizedDesignator: string;
  lowerLimit: string;
  upperLimit: string;
  activationFrom: string;
  activationTo: string;
  responsibleUnit?: string;
  activity?: string;
  status: "planned" | "updated" | "cancelled";
  sourceDocument: "AUP" | "UUP";
  sourceUrl: string;
  observedAt: string;
  geometry?: GeoJsonGeometry;
  matchedGeozoneIdent?: string;
  matchedGeozonePublication?: string;
}

export class AirspaceActivationService {
  private readonly cache: ManagedResponseCache<LoadedActivations>;

  constructor(
    private readonly config: FlightDataConfig,
    private readonly uasGeozones: UasGeozoneService
  ) {
    this.cache = new ManagedResponseCache<LoadedActivations>({
      ttlMs: Math.max(60, config.airspaceActivationCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.airspaceActivationCacheTtlSeconds, 30 * 60) * 1000,
      maxEntries: 1
    });
  }

  async getFeatureCollection(query: AirspaceActivationQuery): Promise<AirspaceActivationFeatureCollection> {
    const loaded = await this.loadActivations();
    const activations = loaded.activations.filter((item) => query.includeCancelled || item.status !== "cancelled");
    const withGeometry = activations.filter((item) => item.geometry && geometryIntersectsBbox(item.geometry, query.bbox));
    const limited = withGeometry.slice(0, query.limit);
    return {
      type: "FeatureCollection",
      contractVersion: "flight-airspace-activation-v1",
      generatedAt: new Date().toISOString(),
      features: limited.map((activation) => toFeature(activation, loaded.warnings.length > 0)),
      source: {
        sourceId: "czech_aup_uup",
        label: "ANS CR AUP/UUP airspace activation",
        baseUrl: this.config.airspaceActivationBaseUrl,
        loadedAt: loaded.loadedAt,
        validFrom: loaded.validFrom,
        validTo: loaded.validTo,
        warnings: loaded.warnings
      },
      summary: {
        activationCount: activations.length,
        returnedActivations: limited.length,
        cancelledCount: activations.filter((item) => item.status === "cancelled").length,
        withGeometryCount: withGeometry.length,
        notForNavigation: true
      },
      warnings: loaded.warnings
    };
  }

  cacheStats(): ManagedResponseCacheStats {
    return this.cache.stats();
  }

  private async loadActivations(): Promise<LoadedActivations> {
    if (!this.config.airspaceActivationEnabled) {
      return {
        activations: [],
        loadedAt: new Date().toISOString(),
        warnings: ["Airspace activation import is disabled."]
      };
    }
    return this.cache.getOrLoad("aup:uup:current", async () => {
      const loadedAt = new Date().toISOString();
      const warnings: string[] = [];
      try {
        const indexHtml = await requestText(this.config.airspaceActivationBaseUrl, this.config.requestTimeoutMs);
        const links = parseAupIndex(indexHtml, this.config.airspaceActivationBaseUrl);
        const uas = await this.uasGeozones.getLoadedGeozones();
        const geozoneIndex = buildGeozoneIndex(uas);
        const records: AirspaceActivationRecord[] = [];
        const aupHtml = links.aupUrl ? await requestText(links.aupUrl, this.config.requestTimeoutMs, "windows-1250") : undefined;
        if (aupHtml && links.aupUrl) {
          records.push(...parseActivationRows(aupHtml, links.aupUrl, "AUP", geozoneIndex));
        } else {
          warnings.push("Current AUP link was not found.");
        }
        const uupHtml = links.uupUrl ? await requestText(links.uupUrl, this.config.requestTimeoutMs, "windows-1250") : undefined;
        if (uupHtml && links.uupUrl) {
          records.push(...parseActivationRows(uupHtml, links.uupUrl, "UUP", geozoneIndex));
        }
        const missingGeometry = records.filter((item) => !item.geometry).map((item) => item.designator);
        if (missingGeometry.length > 0) {
          warnings.push(`AUP/UUP activations without matching geometry: ${[...new Set(missingGeometry)].sort().join(", ")}.`);
        }
        return {
          activations: records,
          loadedAt,
          validFrom: links.validFrom,
          validTo: links.validTo,
          warnings
        };
      } catch (error) {
        return {
          activations: [],
          loadedAt,
          warnings: [error instanceof Error ? `AUP/UUP import failed: ${error.message}` : "AUP/UUP import failed."]
        };
      }
    });
  }
}

interface AupIndexLinks {
  aupUrl?: string;
  uupUrl?: string;
  validFrom?: string;
  validTo?: string;
}

export function parseAupIndex(html: string, baseUrl: string): AupIndexLinks {
  const aup = html.match(/<A\s+HREF="([^"]+)">\s*Platn[ýy]\s+AUP\s*<\/A>\s*\(od\s*([^)]+?)\s*do\s*([^)]+?)\)/i);
  const uup = html.match(/<A\s+HREF="([^"]+)">\s*Platn[ýy]\s+UUP\s*<\/A>/i);
  return {
    aupUrl: aup?.[1] ? new URL(aup[1], baseUrl).toString() : undefined,
    uupUrl: uup?.[1] ? new URL(uup[1], baseUrl).toString() : undefined,
    validFrom: parseCzechUtcTimestamp(aup?.[2]),
    validTo: parseCzechUtcTimestamp(aup?.[3])
  };
}

function parseActivationRows(
  html: string,
  sourceUrl: string,
  sourceDocument: "AUP" | "UUP",
  geozoneIndex: Map<string, Array<{ ident: string; publication: string; geometry: GeoJsonGeometry }>>
): AirspaceActivationRecord[] {
  const period = parseDocumentPeriod(html);
  const section = extractSection(html, "C/", "D/");
  if (!section) {
    return [];
  }
  return [...section.matchAll(/<TR>\s*((?:<TD class="data">[\s\S]*?<\/TD>)+)\s*<\/TR>/gi)]
    .map((match) => [...(match[1] ?? "").matchAll(/<TD class="data">([\s\S]*?)<\/TD>/gi)].map((cell) => stripHtml(cell[1] ?? "")))
    .filter((cells) => cells.length >= 8)
    .flatMap((cells, index) => {
      const designator = cells[1] ?? "";
      const normalized = normalizeActivationDesignator(designator);
      const matches = findGeozoneMatches(normalized, geozoneIndex);
      const status: AirspaceActivationRecord["status"] =
        sourceDocument === "UUP" ? ((cells[7] ?? "").toUpperCase() === "CNL" ? "cancelled" : "updated") : "planned";
      const base = {
        designator,
        normalizedDesignator: normalized,
        lowerLimit: cells[2] ?? "UNKNOWN",
        upperLimit: cells[3] ?? "UNKNOWN",
        activationFrom: combineDateTime(period.fromDate, cells[4]) ?? period.validFrom ?? new Date().toISOString(),
        activationTo: combineDateTime(period.toDate, cells[5]) ?? period.validTo ?? new Date().toISOString(),
        responsibleUnit: cleanString(cells[6]),
        activity: cleanString(cells[7]),
        status,
        sourceDocument,
        sourceUrl,
        observedAt: new Date().toISOString()
      };
      if (matches.length === 0) {
        return [
          {
            ...base,
            id: `airspace-activation:cz:${sourceDocument.toLowerCase()}:${index + 1}:${normalized.toLowerCase()}`
          }
        ];
      }
      return matches.map((matchItem, matchIndex) => ({
        ...base,
        id: `airspace-activation:cz:${sourceDocument.toLowerCase()}:${index + 1}:${normalized.toLowerCase()}:${matchIndex + 1}`,
        geometry: matchItem.geometry,
        matchedGeozoneIdent: matchItem.ident,
        matchedGeozonePublication: matchItem.publication
      }));
    });
}

function toFeature(activation: AirspaceActivationRecord, stale: boolean): AirspaceActivationFeature {
  if (!activation.geometry || !activation.matchedGeozoneIdent || !activation.matchedGeozonePublication) {
    throw new Error("Activation feature requires geometry.");
  }
  return {
    type: "Feature",
    id: activation.id,
    geometry: activation.geometry,
    properties: {
      layerId: CATALOG_LAYER_ID,
      providerId: PROVIDER_ID,
      providerLayerId: PROVIDER_LAYER_ID,
      sourceId: "czech_aup_uup",
      category: "airspace_activation",
      label: `${activation.designator} ${activation.status}`.trim(),
      observedAt: activation.observedAt,
      stale,
      confidence: stale ? 0.66 : 0.82,
      severity: activation.status === "cancelled" ? "info" : "warning",
      designator: activation.designator,
      normalizedDesignator: activation.normalizedDesignator,
      lowerLimit: activation.lowerLimit,
      upperLimit: activation.upperLimit,
      activationFrom: activation.activationFrom,
      activationTo: activation.activationTo,
      status: activation.status,
      responsibleUnit: activation.responsibleUnit,
      activity: activation.activity,
      notForNavigation: true,
      providerProperties: {
        sourceDocument: activation.sourceDocument,
        sourceUrl: activation.sourceUrl,
        matchedGeozoneIdent: activation.matchedGeozoneIdent,
        matchedGeozonePublication: activation.matchedGeozonePublication
      }
    }
  };
}

function buildGeozoneIndex(loaded: LoadedUasGeozones): Map<string, Array<{ ident: string; publication: string; geometry: GeoJsonGeometry }>> {
  const index = new Map<string, Array<{ ident: string; publication: string; geometry: GeoJsonGeometry }>>();
  for (const feature of loaded.features) {
    for (const key of geozoneKeys(feature.ident)) {
      const records = index.get(key) ?? [];
      records.push({ ident: feature.ident, publication: feature.publication, geometry: feature.geometry });
      index.set(key, records);
    }
  }
  return index;
}

function findGeozoneMatches(normalized: string, index: Map<string, Array<{ ident: string; publication: string; geometry: GeoJsonGeometry }>>) {
  const exact = index.get(normalized);
  if (exact && exact.length > 0) {
    return exact;
  }
  const prefixMatches = [...index.entries()].filter(([key]) => key.startsWith(normalized)).flatMap(([, values]) => values);
  return prefixMatches.length > 0 ? prefixMatches : [];
}

function geozoneKeys(ident: string): string[] {
  const upper = ident.toUpperCase();
  const keys = new Set([upper]);
  if (upper.startsWith("LKTRA")) {
    keys.add(upper.replace(/^LK/, ""));
  }
  if (upper.startsWith("LKTSA")) {
    keys.add(upper.replace(/^LK/, ""));
  }
  return [...keys];
}

function normalizeActivationDesignator(value: string): string {
  const normalized = value.toUpperCase().replace(/\s+/g, "");
  if (normalized.startsWith("TRA")) {
    return `LK${normalized}`;
  }
  if (normalized.startsWith("TSA")) {
    return `LK${normalized}`;
  }
  return normalized;
}

function parseDocumentPeriod(html: string): { validFrom?: string; validTo?: string; fromDate?: string; toDate?: string } {
  const match = stripHtml(html.match(/OD\s+\d{2}\.\s*\d{2}\.\s*\d{4}[\s\S]*?DO\s+\d{2}\.\s*\d{2}\.\s*\d{4}[\s\S]*?<\/TD>/i)?.[0] ?? "").match(
    /OD\s+(\d{2})\.\s*(\d{2})\.\s*(\d{4})\s+(\d{2}):(\d{2})\s+DO\s+(\d{2})\.\s*(\d{2})\.\s*(\d{4})\s+(\d{2}):(\d{2})/i
  );
  if (!match) {
    return {};
  }
  const fromDate = `${match[3]}-${match[2]}-${match[1]}`;
  const toDate = `${match[8]}-${match[7]}-${match[6]}`;
  return {
    validFrom: `${fromDate}T${match[4]}:${match[5]}:00.000Z`,
    validTo: `${toDate}T${match[9]}:${match[10]}:00.000Z`,
    fromDate,
    toDate
  };
}

function combineDateTime(date: string | undefined, time: string | undefined): string | undefined {
  const match = time?.match(/^(\d{2}):(\d{2})$/);
  if (!date || !match) {
    return undefined;
  }
  return `${date}T${match[1]}:${match[2]}:00.000Z`;
}

function parseCzechUtcTimestamp(value: string | undefined): string | undefined {
  const match = value?.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})\s+UTC/i);
  return match ? `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00.000Z` : undefined;
}

function extractSection(html: string, start: string, end: string): string | undefined {
  const startIndex = html.indexOf(start);
  if (startIndex < 0) {
    return undefined;
  }
  const endIndex = html.indexOf(end, startIndex + start.length);
  return endIndex > startIndex ? html.slice(startIndex, endIndex) : html.slice(startIndex);
}

async function requestText(url: string, timeoutMs: number, encoding: "utf-8" | "windows-1250" = "utf-8"): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,*/*",
      "user-agent": "csm-sim-flight-data/0.1"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  const buffer = await response.arrayBuffer();
  return new TextDecoder(encoding).decode(buffer);
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|\u00a0/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanString(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned && cleaned.length > 0 && cleaned !== "---" ? cleaned : undefined;
}
