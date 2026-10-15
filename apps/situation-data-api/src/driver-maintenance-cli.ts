import { createProductionDriverRetentionLifecycle, type DriverRetentionControl } from "./driver-retention-lifecycle.js";

/**
 * Standalone retention uses the same production lifecycle as the application.
 * Its default production boundary is deliberately unavailable until a reviewed
 * real producer exists. A future accepted composition may pass the same guarded
 * control as the API; this entry point has no SQL/secret/CLI-selector bypass.
 */
export async function runDriverMaintenance(lifecycle: DriverRetentionControl = createProductionDriverRetentionLifecycle()): Promise<void> {
  try {
    await lifecycle.init();
    await lifecycle.runOnce();
  } finally {
    await lifecycle.close();
  }
}
