import { initializeObservability } from "@csm-sim/observability";
import { loadConfig } from "./config.js";

const observability = await initializeObservability({ serviceName: "csm-sim-flight-data-api" });
const { createApp } = await import("./app.js");
const config = await loadConfig();
const { app } = await createApp(config);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void observability.shutdown().finally(() => process.exit(0));
  });
}

app.listen(config.port, () => {
  console.log(`Flight Data API listening on ${config.port}`);
});
