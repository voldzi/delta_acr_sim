import { createApp } from "./app.js";
import { BudgetStore } from "./budget.js";
import { loadConfig } from "./config.js";
import { PgSeparateBilling } from "./separate-billing.js";
import { PgAccountErasure } from "./account-erasure.js";
import { loadProductionOwnerCheckpointVerifier } from "./owner-checkpoint.js";
import {loadCleanRouterComposition} from './clean-bootstrap.js';

const config = loadConfig();
if (!["gpt-6-luna", "gpt-6-sol"].includes(config.economyModel) || config.economyModel !== "gpt-6-luna" || config.advancedModel !== "gpt-6-sol") {
  throw new Error("Only priced, reviewed models gpt-6-luna and gpt-6-sol are permitted");
}
const store = new BudgetStore(config.databaseUrl, config.userHashSecret, {
  dailyMicrousd: config.dailyMicrousd,
  monthlyMicrousd: config.monthlyMicrousd,
  perUserDailyRequests: config.perUserDailyRequests
});
const clean=await loadCleanRouterComposition(config,store);
await store.init();
const safetyMode=process.env.SIM_ACCOUNT_ERASURE_AUTHORITY_MODE??"root_native_v1";
if(!["root_native_v1","database_v2"].includes(safetyMode))throw new Error("Invalid SIM account-erasure authority mode");
const databaseBinding=!clean&&safetyMode==="database_v2"?await (await import("./database-erasure.js")).loadDatabaseRouterGuard(store.pool):undefined;
const verifyCheckpoint = clean?async()=>false:databaseBinding?(checkpoint:import("./account-erasure.js").Checkpoint)=>databaseBinding.safety.verifyRouterCheckpoint(checkpoint):await loadProductionOwnerCheckpointVerifier();
const erasure = clean?undefined:new PgAccountErasure(store.pool, config.accountErasureCostPolicy ?? "pending_requires_review", config.accountErasureReplayReady === true, verifyCheckpoint,databaseBinding?.safety);
await erasure?.checkSchema();
store.accountErasure = clean?.gate??erasure;
// Restore replay creates actual pending fences. Settle eligible primary rows
// before exposing this DBv2 runtime; uncertain provider reservations stay fenced.
if(databaseBinding)await erasure?.processPending();
const separate = config.copByokEnabled || config.simIzsEnabled ? new PgSeparateBilling(store.pool, config.credentialEncryptionKey!, clean?.gate??erasure) : undefined;
if(separate)separate.cleanLifecycleEnabled=!!clean;
if (separate) await separate.checkSchema();
clean?.start();
const server = createApp(config, store, separate, erasure,clean?.options).listen(config.port, "0.0.0.0", () => {
  console.log(`AI Router listening on ${config.port}`);
});
let advancing = false;
let lastWorkerWarning = 0;
const cleanup = erasure?setInterval(() => {
  if (advancing) return;
  advancing = true;
  void erasure?.processPending().catch(() => {
    if (Date.now()-lastWorkerWarning>=60_000) {
      lastWorkerWarning=Date.now();
      console.warn(JSON.stringify({event:"ai_router_erasure_worker_failed",code:"STORE_OR_AUTHORITY_UNAVAILABLE"}));
    }
  }).finally(() => { advancing = false; });
}, 15_000):undefined;
cleanup?.unref();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () =>
    server.close(() => {
      clearInterval(cleanup);
      void (clean?.close()??Promise.resolve()).finally(()=>store.close()).finally(()=>databaseBinding?.close()).finally(() => process.exit(0));
    })
  );
}
