import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import type { SituationDataConfig } from "./config.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import {
  CHMI_RADAR_DATA_BBOX,
  CHMI_RADAR_IMAGE_BBOX,
  chmiRadarHrefsFromIndex,
  chmiRadarProductDefinitions,
  joinUrl,
  parseChmiRadarTimestampFromHref,
  type ChmiRadarProductDefinition
} from "./chmi-radar.js";
import type { BoundingBox } from "./types.js";

const CHMI_RADAR_CLEAN_CACHE_VERSION = 2;
const CHMI_RADAR_CLEAN_CACHE_DIR = `clean-v${CHMI_RADAR_CLEAN_CACHE_VERSION}`;

export interface WeatherRadarFrameCatalogQuery {
  productIds?: string[];
  historyHours?: number;
  limit?: number;
  materialize?: boolean;
}

export interface WeatherRadarFrameCatalogResponse {
  contractVersion: "sim-weather-radar-frames-v1";
  providerId: "sim.situation-data";
  sourceId: "chmi_weather_radar";
  generatedAt: string;
  historyHours: number;
  frameStore: {
    enabled: boolean;
    mode: "metadata_only" | "local_filesystem";
    assetBasePath: string;
    cleanAssetBasePath: string;
  };
  rasterSemantics: {
    projection: "EPSG:3857";
    boundsWgs84: [number, number, number, number];
    dataBoundsWgs84: [number, number, number, number];
    sourceImageMayContainFrame: boolean;
    sourceImageMayContainEmbeddedLabels: boolean;
    cleanRasterAvailable: boolean;
    cleanMethod: "server_crop_to_data_bounds";
    cleanCropInsetPixels: number;
  };
  products: WeatherRadarFrameProduct[];
  warnings: string[];
}

export interface WeatherRadarFrameProduct {
  productId: string;
  layer: string;
  providerLayerId: string;
  catalogLayerId: string;
  label: string;
  description: string;
  contentType: string;
  updateCadenceSeconds: number;
  validForSeconds: number;
  styleHint: string;
  forecastArchive: boolean;
  forecastHorizonMinutes?: number;
  colorScaleUrl?: string;
  frames: WeatherRadarFrame[];
}

export interface WeatherRadarFrame {
  frameId: string;
  productId: string;
  observedAt: string;
  validUntil?: string;
  sourceUrl: string;
  sourceRevision: string;
  contentType: string;
  sourceImageMayContainFrame: boolean;
  sourceImageMayContainEmbeddedLabels: boolean;
  cleanRasterAvailable: boolean;
  cleanUrl?: string;
  cleanStored?: boolean;
  cleanBoundsWgs84?: [number, number, number, number];
  cleanMethod?: "server_crop_to_data_bounds";
  boundsWgs84: [number, number, number, number];
  dataBoundsWgs84: [number, number, number, number];
  stored: boolean;
  localUrl?: string;
}

export interface StoredRadarFrameAsset {
  path: string;
  contentType: string;
}

export class ChmiWeatherRadarFrameCatalog {
  private readonly indexCache: ManagedResponseCache<string>;
  private readonly cleanMaterializations = new Map<string, Promise<boolean>>();

  constructor(private readonly config: SituationDataConfig) {
    this.indexCache = new ManagedResponseCache<string>({
      ttlMs: Math.max(60, config.chmiWeatherRadarCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.chmiWeatherRadarCacheTtlSeconds, config.staleIfErrorSeconds, 1800) * 1000,
      maxEntries: Math.max(8, Math.min(config.cacheMaxEntries, 256))
    });
  }

  cacheStats(): ManagedResponseCacheStats {
    return this.indexCache.stats();
  }

  async listFrames(query: WeatherRadarFrameCatalogQuery = {}): Promise<WeatherRadarFrameCatalogResponse> {
    const generatedAt = new Date().toISOString();
    const historyHours = normalizeHistoryHours(query.historyHours, this.config.chmiWeatherRadarFrameHistoryHours);
    const limit = normalizeLimit(query.limit, this.config.chmiWeatherRadarFrameMaxCount);
    const materialize = this.config.chmiWeatherRadarFrameStoreEnabled || query.materialize === true;
    const allowedProducts = new Set(query.productIds?.filter(Boolean));
    const definitions = chmiRadarProductDefinitions().filter((definition) =>
      allowedProducts.size === 0 || allowedProducts.has(definition.productId)
    );
    const warnings: string[] = [];
    const products = await Promise.all(
      definitions.map(async (definition) => this.listProductFrames(definition, historyHours, limit, materialize, warnings))
    );

    return {
      contractVersion: "sim-weather-radar-frames-v1",
      providerId: "sim.situation-data",
      sourceId: "chmi_weather_radar",
      generatedAt,
      historyHours,
      frameStore: {
        enabled: this.config.chmiWeatherRadarFrameStoreEnabled,
        mode: this.config.chmiWeatherRadarFrameStoreEnabled ? "local_filesystem" : "metadata_only",
        assetBasePath: "/api/v1/weather-radar/assets",
        cleanAssetBasePath: "/api/v1/weather-radar/clean"
      },
      rasterSemantics: {
        projection: "EPSG:3857",
        boundsWgs84: bboxToArray(CHMI_RADAR_IMAGE_BBOX),
        dataBoundsWgs84: bboxToArray(CHMI_RADAR_DATA_BBOX),
        sourceImageMayContainFrame: true,
        sourceImageMayContainEmbeddedLabels: true,
        cleanRasterAvailable: true,
        cleanMethod: "server_crop_to_data_bounds",
        cleanCropInsetPixels: this.config.chmiWeatherRadarCleanCropInsetPixels
      },
      products,
      warnings
    };
  }

  async storedAsset(productId: string, fileName: string): Promise<StoredRadarFrameAsset | undefined> {
    const definition = chmiRadarProductDefinitions().find((item) => item.productId === productId);
    if (!definition || !definition.filePattern.test(fileName)) {
      return undefined;
    }
    const path = this.storedFramePath(productId, fileName);
    try {
      await access(path);
    } catch {
      return undefined;
    }
    return { path, contentType: definition.contentType };
  }

  async cleanAsset(productId: string, fileName: string): Promise<StoredRadarFrameAsset | undefined> {
    const definition = chmiRadarProductDefinitions().find((item) => item.productId === productId);
    if (!definition || definition.contentType !== "image/png" || !definition.filePattern.test(fileName)) {
      return undefined;
    }
    const path = this.cleanFramePath(productId, fileName);
    if (!(await fileExists(path))) {
      await this.materializeCleanFrame(definition, fileName);
    }
    return { path, contentType: "image/png" };
  }

  private async listProductFrames(
    definition: ChmiRadarProductDefinition,
    historyHours: number,
    limit: number,
    materialize: boolean,
    warnings: string[]
  ): Promise<WeatherRadarFrameProduct> {
    const indexUrl = joinUrl(this.config.chmiWeatherRadarBaseUrl, definition.indexPath);
    const sinceMs = Date.now() - historyHours * 60 * 60 * 1000;
    let hrefs: string[] = [];
    try {
      const html = await this.indexCache.getOrLoad(indexUrl, () => requestText(indexUrl, this.config.requestTimeoutMs));
      hrefs = chmiRadarHrefsFromIndex(html, definition.filePattern)
        .filter((href) => {
          const observedAt = parseChmiRadarTimestampFromHref(href);
          return observedAt ? Date.parse(observedAt) >= sinceMs : false;
        })
        .slice(0, limit);
    } catch (error) {
      warnings.push(
        `chmi_weather_radar frame index failed for ${definition.productId}: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }

    const frames = await Promise.all(
      hrefs.map((href) => this.frameFromHref(definition, indexUrl, href, materialize, warnings))
    );

    return {
      productId: definition.productId,
      layer: definition.layer,
      providerLayerId: providerLayerIdForRadarLayer(definition.layer),
      catalogLayerId: catalogLayerIdForRadarLayer(definition.layer),
      label: definition.label,
      description: definition.description,
      contentType: definition.contentType,
      updateCadenceSeconds: definition.updateCadenceSeconds,
      validForSeconds: definition.validForSeconds,
      styleHint: definition.styleHint,
      forecastArchive: definition.forecastArchive,
      forecastHorizonMinutes: definition.forecastHorizonMinutes,
      colorScaleUrl: definition.legendUrl,
      frames
    };
  }

  private async frameFromHref(
    definition: ChmiRadarProductDefinition,
    indexUrl: string,
    href: string,
    materialize: boolean,
    warnings: string[]
  ): Promise<WeatherRadarFrame> {
    const observedAt = parseChmiRadarTimestampFromHref(href) ?? new Date().toISOString();
    const sourceUrl = joinUrl(indexUrl, href);
    let stored = await fileExists(this.storedFramePath(definition.productId, href));
    if (materialize && !stored) {
      stored = await this.materializeFrame(definition, href, sourceUrl, warnings);
    }
    const cleanRasterAvailable = definition.contentType === "image/png";
    let cleanStored = cleanRasterAvailable ? await fileExists(this.cleanFramePath(definition.productId, href)) : false;
    if (materialize && cleanRasterAvailable && !cleanStored) {
      cleanStored = await this.materializeCleanFrame(definition, href, warnings);
    }
    return {
      frameId: `chmi_weather_radar:${definition.productId}:${observedAt.replace(/[:.]/g, "")}`,
      productId: definition.productId,
      observedAt,
      validUntil: addSecondsIso(observedAt, definition.validForSeconds),
      sourceUrl,
      sourceRevision: href,
      contentType: definition.contentType,
      sourceImageMayContainFrame: true,
      sourceImageMayContainEmbeddedLabels: true,
      cleanRasterAvailable,
      cleanUrl: cleanRasterAvailable ? cleanFrameUrl(definition.productId, href) : undefined,
      cleanStored,
      cleanBoundsWgs84: cleanRasterAvailable ? bboxToArray(CHMI_RADAR_DATA_BBOX) : undefined,
      cleanMethod: cleanRasterAvailable ? "server_crop_to_data_bounds" : undefined,
      boundsWgs84: bboxToArray(CHMI_RADAR_IMAGE_BBOX),
      dataBoundsWgs84: bboxToArray(CHMI_RADAR_DATA_BBOX),
      stored,
      localUrl: stored ? `/api/v1/weather-radar/assets/${encodeURIComponent(definition.productId)}/${encodeURIComponent(href)}` : undefined
    };
  }

  private async materializeFrame(definition: ChmiRadarProductDefinition, href: string, sourceUrl: string, warnings: string[]): Promise<boolean> {
    const destination = this.storedFramePath(definition.productId, href);
    try {
      await mkdir(resolve(this.config.chmiWeatherRadarFrameStoreDir, definition.productId), { recursive: true });
      const body = await requestBinary(sourceUrl, this.config.requestTimeoutMs);
      await writeFile(destination, body);
      return true;
    } catch (error) {
      warnings.push(
        `chmi_weather_radar frame materialization failed for ${definition.productId}/${href}: ${error instanceof Error ? error.message : "unknown error"}`
      );
      return false;
    }
  }

  private async materializeCleanFrame(definition: ChmiRadarProductDefinition, href: string, warnings?: string[]): Promise<boolean> {
    const key = `${definition.productId}/${href}`;
    const existing = this.cleanMaterializations.get(key);
    if (existing) {
      return await this.resolveCleanMaterialization(existing, definition.productId, href, warnings);
    }
    const promise = this.createCleanFrame(definition, href).finally(() => {
      this.cleanMaterializations.delete(key);
    });
    this.cleanMaterializations.set(key, promise);
    return await this.resolveCleanMaterialization(promise, definition.productId, href, warnings);
  }

  private async resolveCleanMaterialization(
    promise: Promise<boolean>,
    productId: string,
    href: string,
    warnings?: string[]
  ): Promise<boolean> {
    try {
      return await promise;
    } catch (error) {
      warnings?.push(
        `chmi_weather_radar clean frame materialization failed for ${productId}/${href}: ${error instanceof Error ? error.message : "unknown error"}`
      );
      if (!warnings) {
        throw error;
      }
      return false;
    }
  }

  private async createCleanFrame(definition: ChmiRadarProductDefinition, href: string): Promise<boolean> {
    const sourceUrl = joinUrl(joinUrl(this.config.chmiWeatherRadarBaseUrl, definition.indexPath), href);
    const destination = this.cleanFramePath(definition.productId, href);
    await mkdir(resolve(this.config.chmiWeatherRadarFrameStoreDir, CHMI_RADAR_CLEAN_CACHE_DIR, definition.productId), { recursive: true });
    const rawBody = await this.rawFrameBody(definition, href, sourceUrl);
    const cleanBody = cropPngToDataBounds(rawBody, this.config.chmiWeatherRadarCleanCropInsetPixels);
    await writeFile(destination, cleanBody);
    return true;
  }

  private async rawFrameBody(definition: ChmiRadarProductDefinition, href: string, sourceUrl: string): Promise<Uint8Array> {
    const storedPath = this.storedFramePath(definition.productId, href);
    if (await fileExists(storedPath)) {
      return new Uint8Array(await readFile(storedPath));
    }
    return requestBinary(sourceUrl, this.config.requestTimeoutMs);
  }

  private storedFramePath(productId: string, fileName: string): string {
    return resolve(this.config.chmiWeatherRadarFrameStoreDir, productId, fileName);
  }

  private cleanFramePath(productId: string, fileName: string): string {
    return resolve(this.config.chmiWeatherRadarFrameStoreDir, CHMI_RADAR_CLEAN_CACHE_DIR, productId, fileName);
  }
}

function cleanFrameUrl(productId: string, href: string): string {
  return `/api/v1/weather-radar/clean/${encodeURIComponent(productId)}/${encodeURIComponent(href)}?v=${CHMI_RADAR_CLEAN_CACHE_VERSION}`;
}

function cropPngToDataBounds(input: Uint8Array, insetPixels: number): Uint8Array {
  const source = PNG.sync.read(Buffer.from(input));
  const inset = Math.max(0, Math.trunc(insetPixels));
  const crop = detectedDataAreaCropBox(source, inset) ?? cropBoxForDataBounds(source.width, source.height, inset);
  const output = new PNG({ width: crop.width, height: crop.height });
  for (let y = 0; y < crop.height; y += 1) {
    const sourceStart = ((crop.y + y) * source.width + crop.x) * 4;
    const sourceEnd = sourceStart + crop.width * 4;
    const destinationStart = y * crop.width * 4;
    source.data.copy(output.data, destinationStart, sourceStart, sourceEnd);
  }
  removeFrameArtifactPixels(output);
  return PNG.sync.write(output);
}

function detectedDataAreaCropBox(source: PNG, insetPixels: number): { x: number; y: number; width: number; height: number } | undefined {
  const minRunWidth = Math.max(24, Math.floor(source.width * 0.2));
  const minFramePixels = Math.max(12, Math.floor(source.width * 0.03));
  let minX = source.width;
  let minY = source.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < source.height; y += 1) {
    const run = longestDataAreaRunInRow(source, y);
    if (!run || run.width < minRunWidth || frameArtifactPixelsInRow(source, y) < minFramePixels) {
      continue;
    }
    minX = Math.min(minX, run.x);
    maxX = Math.max(maxX, run.x + run.width - 1);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  if (maxX < minX || maxY < minY) {
    return undefined;
  }

  const x = clampInt(minX + insetPixels, 0, source.width - 1);
  const y = clampInt(minY + insetPixels, 0, source.height - 1);
  const right = clampInt(maxX + 1 - insetPixels, x + 1, source.width);
  const bottom = clampInt(maxY + 1 - insetPixels, y + 1, source.height);
  if (right - x < 32 || bottom - y < 32) {
    return undefined;
  }
  return { x, y, width: right - x, height: bottom - y };
}

function frameArtifactPixelsInRow(source: PNG, y: number): number {
  let count = 0;
  for (let x = 0; x < source.width; x += 1) {
    if (isFrameArtifactPixel(source.data, (y * source.width + x) * 4)) {
      count += 1;
    }
  }
  return count;
}

function longestDataAreaRunInRow(source: PNG, y: number): { x: number; width: number } | undefined {
  let bestX = -1;
  let bestWidth = 0;
  let currentX = -1;
  let currentWidth = 0;

  for (let x = 0; x < source.width; x += 1) {
    const offset = (y * source.width + x) * 4;
    if (isDataAreaPixel(source.data, offset)) {
      if (currentX < 0) {
        currentX = x;
        currentWidth = 0;
      }
      currentWidth += 1;
    } else if (currentX >= 0) {
      if (currentWidth > bestWidth) {
        bestX = currentX;
        bestWidth = currentWidth;
      }
      currentX = -1;
      currentWidth = 0;
    }
  }

  if (currentX >= 0 && currentWidth > bestWidth) {
    bestX = currentX;
    bestWidth = currentWidth;
  }
  return bestX >= 0 ? { x: bestX, width: bestWidth } : undefined;
}

function isDataAreaPixel(data: Buffer, offset: number): boolean {
  const alpha = data[offset + 3] ?? 0;
  if (alpha === 0) {
    return true;
  }
  return !isFrameArtifactPixel(data, offset);
}

function removeFrameArtifactPixels(image: PNG): void {
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (isFrameArtifactPixel(image.data, offset)) {
      image.data[offset] = 0;
      image.data[offset + 1] = 0;
      image.data[offset + 2] = 0;
      image.data[offset + 3] = 0;
    }
  }
}

function isFrameArtifactPixel(data: Buffer, offset: number): boolean {
  const red = data[offset] ?? 0;
  const green = data[offset + 1] ?? 0;
  const blue = data[offset + 2] ?? 0;
  const alpha = data[offset + 3] ?? 0;
  if (alpha === 0) {
    return false;
  }
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const isNeutralGrayFrame = max - min <= 8 && red >= 110 && green >= 110 && blue >= 110;
  const isBlackFrameOrLabel = red <= 8 && green <= 8 && blue <= 8;
  return isNeutralGrayFrame || isBlackFrameOrLabel;
}

function cropBoxForDataBounds(width: number, height: number, insetPixels: number): { x: number; y: number; width: number; height: number } {
  const lonSpan = CHMI_RADAR_IMAGE_BBOX.east - CHMI_RADAR_IMAGE_BBOX.west;
  const latSpan = CHMI_RADAR_IMAGE_BBOX.north - CHMI_RADAR_IMAGE_BBOX.south;
  const x1 = Math.floor(((CHMI_RADAR_DATA_BBOX.west - CHMI_RADAR_IMAGE_BBOX.west) / lonSpan) * width) + insetPixels;
  const x2 = Math.ceil(((CHMI_RADAR_DATA_BBOX.east - CHMI_RADAR_IMAGE_BBOX.west) / lonSpan) * width) - insetPixels;
  const y1 = Math.floor(((CHMI_RADAR_IMAGE_BBOX.north - CHMI_RADAR_DATA_BBOX.north) / latSpan) * height) + insetPixels;
  const y2 = Math.ceil(((CHMI_RADAR_IMAGE_BBOX.north - CHMI_RADAR_DATA_BBOX.south) / latSpan) * height) - insetPixels;
  const x = clampInt(x1, 0, width - 1);
  const y = clampInt(y1, 0, height - 1);
  const right = clampInt(x2, x + 1, width);
  const bottom = clampInt(y2, y + 1, height);
  return { x, y, width: right - x, height: bottom - y };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeHistoryHours(value: number | undefined, fallback: number): number {
  const normalized = Number(value ?? fallback);
  return Number.isFinite(normalized) ? Math.max(1, Math.min(Math.round(normalized), 72)) : 6;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  const normalized = Number(value ?? fallback);
  return Number.isFinite(normalized) ? Math.max(1, Math.min(Math.round(normalized), 288)) : 72;
}

function providerLayerIdForRadarLayer(layer: string): string {
  switch (layer) {
    case "weather_radar_reflectivity":
      return "weather.radar_reflectivity";
    case "weather_radar_precipitation":
      return "weather.radar_precipitation";
    case "weather_radar_nowcast":
      return "weather.radar_nowcast";
    case "weather_thunderstorm_risk":
      return "weather.thunderstorm_risk";
    default:
      return `weather.${layer}`;
  }
}

function catalogLayerIdForRadarLayer(layer: string): string {
  switch (layer) {
    case "weather_radar_reflectivity":
      return "public.weather.radar_reflectivity";
    case "weather_radar_precipitation":
      return "public.weather.radar_precipitation";
    case "weather_radar_nowcast":
      return "public.weather.radar_nowcast";
    case "weather_thunderstorm_risk":
      return "public.safety.thunderstorm_risk";
    default:
      return `provider.chmi_weather_radar.${layer}`;
  }
}

function bboxToArray(bbox: BoundingBox): [number, number, number, number] {
  return [bbox.west, bbox.south, bbox.east, bbox.north];
}

function addSecondsIso(value: string, seconds: number): string | undefined {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return new Date(timestamp + seconds * 1000).toISOString();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function requestText(url: string, timeoutMs: number): Promise<string> {
  const response = await request(url, timeoutMs);
  return response.text();
}

async function requestBinary(url: string, timeoutMs: number): Promise<Uint8Array> {
  const response = await request(url, timeoutMs);
  return new Uint8Array(await response.arrayBuffer());
}

async function request(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
