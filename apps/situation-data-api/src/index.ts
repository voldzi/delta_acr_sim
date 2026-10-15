import { initializeObservability } from "@csm-sim/observability";
import { loadConfig } from "./config.js";

const observability = await initializeObservability({ serviceName: "csm-sim-situation-data-api" });
const { createApp } = await import("./app.js");
const config = await loadConfig();
const { loadProductionDriverOwnerComposition } = await import("./driver-owner-composition.js");
const safetyMode=process.env.SIM_ACCOUNT_ERASURE_AUTHORITY_MODE??"root_native_v1";
if(!["root_native_v1","database_v2"].includes(safetyMode))throw new Error("Invalid SIM account-erasure authority mode");
const databaseBinding=safetyMode==="database_v2"?await (await import("./database-erasure.js")).loadDatabaseDriverOwnerComposition():undefined;
const ownerBinding = databaseBinding??await loadProductionDriverOwnerComposition();
const { app, context } = await createApp(config, ownerBinding);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void context.driverMeasurements.close().finally(()=>databaseBinding?.close()).finally(() => observability.shutdown()).finally(() => process.exit(0));
  });
}

app.listen(config.port, () => {
  console.log(`Situation Data API listening on :${config.port}`);
});
