import { createProductionDriverRetentionLifecycle } from "./driver-retention-lifecycle.js";

/**
 * Standalone retention uses the same production lifecycle as the application.
 * Its production boundary is deliberately unavailable until a reviewed real
 * producer exists. This entry point has no injected consumer or secret inputs.
 */
export async function runDriverMaintenance(): Promise<void> {
  const lifecycle = createProductionDriverRetentionLifecycle();
  try {
    await lifecycle.init();
    await lifecycle.runOnce();
  } finally {
    await lifecycle.close();
  }
}
