import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const dockerfile = readFileSync(new URL("apps/situation-data-api/Dockerfile", root), "utf8");
const resources = new Set<string>();
for (const file of readdirSync(new URL("apps/situation-data-api/src/", root))) {
  if (!file.endsWith(".ts")) continue;
  const source = readFileSync(new URL(`apps/situation-data-api/src/${file}`, root), "utf8");
  for (const match of source.matchAll(/new URL\(["']\.\.\/\.\.\/\.\.\/(openapi\/fragments\/[^"']+\.json)["']/g)) resources.add(match[1]!);
}
const copied = (text: string, file: string) => text.split("\n").includes(`COPY ${file} ./${file}`);
describe("situation image runtime resources (static packaging, not an image build)", () => {
  it("copies every explicitly imported JSON resource into build and then runtime", () => {
    expect(resources.has("openapi/fragments/planning-origin-v1.openapi.json")).toBe(true);
    for (const resource of resources) {
      expect(copied(dockerfile, resource), resource).toBe(true);
      expect(() => JSON.parse(readFileSync(new URL(resource, root), "utf8"))).not.toThrow();
    }
    expect(dockerfile.split("\n")).toContain("COPY --from=build /app/openapi ./openapi");
  });
  it("detects the previously missing planning COPY rather than trusting local availability", () => {
    const file = "openapi/fragments/planning-origin-v1.openapi.json";
    const broken = dockerfile.replace(`COPY ${file} ./${file}\n`, "");
    expect(copied(broken, file)).toBe(false);
  });
  it("ships a self-contained planning schema with no missing external resources", () => {
    const spec = JSON.parse(readFileSync(new URL("openapi/fragments/planning-origin-v1.openapi.json", root), "utf8"));
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        if (key === "$ref") {
          expect(typeof item).toBe("string"); expect(item).toMatch(/^#\/components\//);
          let target: any = spec;
          for (const part of String(item).slice(2).split("/")) target = target?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
          expect(target, String(item)).toBeDefined();
        } else walk(item);
      }
    };
    walk(spec);
  });
});
