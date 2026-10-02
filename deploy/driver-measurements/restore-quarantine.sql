-- Mandatory after restore and before any measurement connection is enabled.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database()<>'sim_driver_measurements' THEN
    RAISE EXCEPTION 'Refusing to purge a different database';
  END IF;
END $$;
BEGIN;
TRUNCATE driver_measurement_receipts,driver_measurement_revocations CASCADE;
COMMIT;
