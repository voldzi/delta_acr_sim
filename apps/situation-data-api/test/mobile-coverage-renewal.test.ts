import { describe, expect, it, vi } from "vitest";
import { MobileCoverageSource } from "../src/mobile-coverage-source.js";
import { loadConfig } from "../src/config.js";

async function fixture() {
  const source = new MobileCoverageSource({ ...(await loadConfig()), enabledSources: [], mobileCoverageResolutionM: 1000 });
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] as any[] }));
  const release = vi.fn();
  const client = { query, release };
  const internal = source as any;
  internal.ensureReadModelSchemaCached = async () => undefined;
  internal.getPool = () => ({ query, connect: async () => client });
  internal.buildCoverage = vi.fn(async (_bbox: unknown, technologies: string[]) => ({
    features: technologies.map((technology) => ({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [14, 50],
            [14.01, 50],
            [14.01, 50.01],
            [14, 50.01],
            [14, 50]
          ]
        ]
      },
      properties: { featureId: `${technology}:m1000-r1-c1`, technology, generatedAt: new Date().toISOString() }
    }))
  }));
  return { source, internal, query, release };
}
describe("coverage generation", () => {
  it("builds each technology separately and commits one complete tile transaction", async () => {
    const f = await fixture();
    expect(await f.source.replaceReadModelFeatures({ west: 14, south: 50, east: 14.01, north: 50.01 }, ["2G", "4G", "5G"])).toBe(3);
    expect(f.internal.buildCoverage.mock.calls.map((c: any[]) => c[1])).toEqual([["2G"], ["4G"], ["5G"]]);
    const sql = f.query.mock.calls.map((c) => c[0].trim());
    expect(sql[0]).toBe("begin");
    expect(sql.at(-1)).toBe("commit");
    expect(sql.filter((s) => s.startsWith("insert into"))).toHaveLength(3);
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("rolls back a failed insertion so previous cells remain committed", async () => {
    const f = await fixture();
    f.query.mockImplementation(async (sql) => {
      if (sql.includes("insert into")) throw new Error("synthetic insert failure");
      return { rows: [] };
    });
    await expect(f.source.replaceReadModelFeatures({ west: 14, south: 50, east: 14.01, north: 50.01 })).rejects.toThrow("synthetic insert failure");
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("renews absent or expiring technologies but skips a fresh full generation", async () => {
    const f = await fixture();
    const now = Date.now();
    expect(await f.source.readModelNeedsRenewal(["2G", "4G", "5G"], now)).toBe(true);
    f.query.mockResolvedValue({ rows: ["2G", "4G", "5G"].map((technology) => ({ technology, expires_at: new Date(now + 6 * 86400_000) })) });
    expect(await f.source.readModelNeedsRenewal(["2G", "4G", "5G"], now)).toBe(false);
    f.query.mockResolvedValue({ rows: [{ technology: "4G", expires_at: new Date(now + 86400_000) }] });
    expect(await f.source.readModelNeedsRenewal(["4G"], now)).toBe(true);
  });
});
