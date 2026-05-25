import { loadConfig } from "./config.js";
import { MobileCoverageSource } from "./mobile-coverage-source.js";
import type { BoundingBox, MobileCoverageTechnology } from "./types.js";

const DEFAULT_CZECHIA_BBOX: BoundingBox = {
  west: 11.8,
  south: 48.5,
  east: 19.2,
  north: 51.2
};

async function main(): Promise<void> {
  const config = await loadConfig();
  const bbox = parseBbox(process.env.MOBILE_COVERAGE_REBUILD_BBOX) ?? DEFAULT_CZECHIA_BBOX;
  const technologies = parseTechnologies(process.env.MOBILE_COVERAGE_REBUILD_TECHNOLOGIES) ?? ["4G"];
  const tileDegrees = parseNumber(process.env.MOBILE_COVERAGE_REBUILD_TILE_DEGREES, 0.25);
  const source = new MobileCoverageSource(config);
  const tiles = splitBbox(bbox, tileDegrees);
  let written = 0;

  await source.ensureReadModelSchema();
  for (const [index, tile] of tiles.entries()) {
    const count = await source.replaceReadModelFeatures(tile, technologies);
    written += count;
    process.stdout.write(
      JSON.stringify({
        event: "mobile_coverage_tile_rebuilt",
        index: index + 1,
        total: tiles.length,
        count,
        bbox: tile,
        technologies
      }) + "\n"
    );
  }

  process.stdout.write(
    JSON.stringify({
      event: "mobile_coverage_rebuild_complete",
      count: written,
      tileCount: tiles.length,
      bbox,
      technologies,
      modelVersion: config.mobileCoverageModelVersion,
      readModelTable: config.mobileCoverageReadModelTable
    }) + "\n"
  );
}

function splitBbox(bbox: BoundingBox, step: number): BoundingBox[] {
  const normalizedStep = Math.max(0.05, step);
  const tiles: BoundingBox[] = [];
  for (let west = bbox.west; west < bbox.east; west += normalizedStep) {
    for (let south = bbox.south; south < bbox.north; south += normalizedStep) {
      tiles.push({
        west: round(west),
        south: round(south),
        east: round(Math.min(bbox.east, west + normalizedStep)),
        north: round(Math.min(bbox.north, south + normalizedStep))
      });
    }
  }
  return tiles;
}

function parseBbox(value: string | undefined): BoundingBox | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error("MOBILE_COVERAGE_REBUILD_BBOX must be west,south,east,north.");
  }
  const [west, south, east, north] = parts as [number, number, number, number];
  if (west >= east || south >= north) {
    throw new Error("MOBILE_COVERAGE_REBUILD_BBOX has invalid bounds.");
  }
  return { west, south, east, north };
}

function parseTechnologies(value: string | undefined): MobileCoverageTechnology[] | undefined {
  if (!value) {
    return undefined;
  }
  const technologies = value
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter((item): item is MobileCoverageTechnology => item === "2G" || item === "4G" || item === "5G");
  return technologies.length > 0 ? technologies : undefined;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
