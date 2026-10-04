import { readFileSync } from "node:fs";
import { mappedCostOptions, mappedCosting, parseMappedProfile } from "../apps/situation-data-api/dist/mapped-road-profile.js";
const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
const plan = [];
const base = { heightM: 2, widthM: 2, lengthM: 5, loadedWeightKg: 3000 };
function add(name, intent, vehicle, expectedRestricted, final = false) {
  const c = cases.find((c) => c.name === name);
  const profile = { version: "sim-mapped-road-profile-v1", intent, coverageAcknowledged: "mapped_restrictions_incomplete", ...(vehicle ? { vehicle } : {}) };
  parseMappedProfile({ profileId: "car", vehicleProfile: profile, from: c.from, to: c.to });
  for (const reverse of [false, true]) {
    const [from, to] = reverse ? [c.to, c.from] : [c.from, c.to];
    plan.push({
      name: `${name}-${intent}-${expectedRestricted ? "small" : "large"}-${reverse ? "reverse" : "forward"}`,
      restrictedWay: c.restrictedWay,
      finalWay: final ? c.finalWay : null,
      expectedRestricted,
      request: {
        locations: [from, to].map((p) => ({ ...p, minimum_reachability: 1, radius: 10, search_cutoff: 25 })),
        costing: mappedCosting(profile),
        costing_options: { [mappedCosting(profile)]: mappedCostOptions(profile) },
        units: "kilometers"
      }
    });
  }
}
for (const [name, field, large] of [
  ["height", "heightM", 3],
  ["width", "widthM", 2.5],
  ["length", "lengthM", 10],
  ["weight", "loadedWeightKg", 8000]
]) {
  add(name, "car", base, true);
  add(name, "car", { ...base, [field]: large }, false);
  add(name, "commercial_truck", base, true);
  add(name, "commercial_truck", { ...base, [field]: large }, false);
}
add("height", "car", { heightM: 5, widthM: 3, lengthM: 25, loadedWeightKg: 60000 }, false);
add("axleLoad", "commercial_truck", { heightM: 5, widthM: 3, lengthM: 25, loadedWeightKg: 60000, axleLoadKg: 40000, axleCount: 20 }, false);
add(
  "length",
  "car_with_trailer",
  { ...base, lengthM: 12, loadedWeightKg: 4500, trailer: { attached: true, heightM: 1.8, widthM: 1.8, lengthM: 6, loadedWeightKg: 1500 } },
  false
);
add(
  "weight",
  "car_with_trailer",
  { ...base, lengthM: 7, loadedWeightKg: 8000, trailer: { attached: true, heightM: 1.8, widthM: 1.8, lengthM: 3, loadedWeightKg: 5000 } },
  false
);
for (const [name, field, small, large] of [
  ["axleLoad", "axleLoadKg", 5000, 8000],
  ["axleCount", "axleCount", 2, 3]
]) {
  add(name, "commercial_truck", { ...base, loadedWeightKg: 18000, axleLoadKg: 5000, axleCount: 2, [field]: small }, true);
  add(name, "commercial_truck", { ...base, loadedWeightKg: 18000, axleLoadKg: 5000, axleCount: 2, [field]: large }, false);
}
add("access", "road_legal_4x4", base, false);
add("unpavedFinal", "road_legal_4x4", base, true, true);
process.stdout.write(JSON.stringify(plan));
