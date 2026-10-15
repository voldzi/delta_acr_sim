import type { DriverRetentionControl } from "./driver-retention-lifecycle.js";
import { createProductionDriverMaintenanceControl } from "./driver-maintenance-owner.js";

/**
 * Standalone retention uses the same production lifecycle as the application.
 * Its default is the same fixed Root factory as the API. A missing binding
 * stays unavailable before DB construction, never a direct SQL fallback.
 */
export async function runDriverMaintenance(lifecycle?: DriverRetentionControl): Promise<void> {
  const control = lifecycle ?? await createProductionDriverMaintenanceControl();
  try {
    await control.init();
    await control.runOnce();
  } finally {
    await control.close();
  }
}
