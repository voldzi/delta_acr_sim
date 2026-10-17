-- Migration owner, ONLY after explicit clean-empty baseline enrollment.
BEGIN;
GRANT USAGE ON SCHEMA sim_clean TO driver_measurements_runtime;
GRANT SELECT ON sim_clean.config TO driver_measurements_runtime;
GRANT SELECT,INSERT,UPDATE ON sim_clean.account,sim_clean.resource,sim_clean.job,sim_clean.cost_daily TO driver_measurements_runtime;
GRANT DELETE ON sim_clean.cost_daily TO driver_measurements_runtime;
GRANT EXECUTE ON FUNCTION sim_clean.fence() TO driver_measurements_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON driver_measurement_receipts,driver_measurement_intervals,driver_measurement_eta,driver_measurement_revocations TO driver_measurements_runtime;
COMMIT;
