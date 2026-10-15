import { createApp } from "./app.js";
import { BudgetStore } from "./budget.js";
import { loadConfig } from "./config.js";
import { PgSeparateBilling } from "./separate-billing.js";
import { PgAccountErasure } from "./account-erasure.js";
import { loadProductionOwnerCheckpointVerifier } from "./owner-checkpoint.js";

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
const verifyCheckpoint = await loadProductionOwnerCheckpointVerifier();
const erasure = new PgAccountErasure(store.pool, config.accountErasureCostPolicy ?? "pending_requires_review", config.accountErasureReplayReady === true, verifyCheckpoint);
await erasure.checkSchema();
store.accountErasure = erasure;
const separate = config.copByokEnabled || config.simIzsEnabled ? new PgSeparateBilling(store.pool, config.credentialEncryptionKey!, erasure) : undefined;
if (separate) await separate.checkSchema();
const server = createApp(config, store, separate, erasure).listen(config.port, "0.0.0.0", () => {
  console.log(`AI Router listening on ${config.port}`);
});
let advancing = false;
let lastWorkerWarning = 0;
const cleanup = setInterval(() => {
  if (advancing) return;
  advancing = true;
  void erasure.processPending().catch(() => {
    if (Date.now()-lastWorkerWarning>=60_000) {
      lastWorkerWarning=Date.now();
      console.warn(JSON.stringify({event:"ai_router_erasure_worker_failed",code:"STORE_OR_AUTHORITY_UNAVAILABLE"}));
    }
  }).finally(() => { advancing = false; });
}, 15_000);
cleanup.unref();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () =>
    server.close(() => {
      clearInterval(cleanup);
      void store.close().finally(() => process.exit(0));
    })
  );
}
