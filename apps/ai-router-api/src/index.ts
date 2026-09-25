import { createApp } from "./app.js";
import { BudgetStore } from "./budget.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
if (!["gpt-6-luna", "gpt-6-sol"].includes(config.economyModel) || config.economyModel !== "gpt-6-luna" || config.advancedModel !== "gpt-6-sol") {
  throw new Error("Only priced, reviewed models gpt-6-luna and gpt-6-sol are permitted");
}
const store = new BudgetStore(config.databaseUrl, config.userHashSecret, {
  dailyMicrousd: config.dailyMicrousd,
  monthlyMicrousd: config.monthlyMicrousd,
  perUserDailyRequests: config.perUserDailyRequests
});
await store.init();
const server = createApp(config, store).listen(config.port, "0.0.0.0", () => {
  console.log(`AI Router listening on ${config.port}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () =>
    server.close(() => {
      void store.close().finally(() => process.exit(0));
    })
  );
}
