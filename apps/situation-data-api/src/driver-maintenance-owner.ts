import { PostgresDriverMeasurementStore } from "./driver-measurement-store.js";
import { driverSettings } from "./driver-measurements.js";
import { loadProductionDriverOwnerComposition } from "./driver-owner-composition.js";
import { createProductionDriverRetentionLifecycle, DriverRetentionLifecycleError, type DriverRetentionControl } from "./driver-retention-lifecycle.js";

/** Same fixed Root composition as HTTP, including its explicit maintenance
 * consumer. Absence is checked BEFORE settings/DB construction; no CLI selector,
 * direct legacy SQL path, local cutoff or fabricated expire origin is supplied. */
export async function createProductionDriverMaintenanceControl(): Promise<DriverRetentionControl> {
  const binding = await loadProductionDriverOwnerComposition();
  const dependencies = binding.driverMeasurements;
  if (!dependencies.retentionConsumer) return createProductionDriverRetentionLifecycle();
  const settings = driverSettings();
  if (!settings.databaseUrl || !settings.hashSecret || settings.hashSecret.length < 32)
    throw new DriverRetentionLifecycleError("DRIVER_RETENTION_UNAVAILABLE");
  const store = new PostgresDriverMeasurementStore(settings.databaseUrl!, settings.hashSecret!, {
    enabled: settings.driverAccountErasureEnabled,
    identityConfigured: !!settings.driverAccountErasureIssuer && !!settings.driverAccountErasureActorSecret && settings.driverAccountErasureActorSecret.length >= 32,
    expectedCheckpoint: settings.driverAccountErasureReplayCheckpoint,
    // Explicit presence must NEVER fall back to legacy DELETE, even if a
    // defective/incomplete composition were to omit its guarded property.
    guarded: dependencies.guarded ?? {}, retentionConsumer: dependencies.retentionConsumer,
  });
  return Object.freeze({ init: () => store.init(), start: () => store.startRetention(),
    runOnce: () => store.runRetentionOnce(), close: () => store.close() });
}
