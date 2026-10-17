import { initializeObservability } from "@csm-sim/observability";
import { loadConfig } from "./config.js";

const observability = await initializeObservability({ serviceName: "csm-sim-api" });
const { createApp } = await import("./app.js");
const config = await loadConfig();
const { simUserDataSettings, createOwnedSimulatorApp } = await import("./user-data.js");
const userSettings = simUserDataSettings();
const owned = userSettings ? await createOwnedSimulatorApp(config, userSettings) : undefined;
const { app } = owned ?? (await createApp(config));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (owned?.close() ?? Promise.resolve()).finally(() => observability.shutdown()).finally(() => process.exit(0));
  });
}

app.listen(config.port, () => {
  console.log(`SIM API listening on ${config.port}`);
});
