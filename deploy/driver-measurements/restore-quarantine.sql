-- Mandatory after restore and before any measurement connection is enabled.
\set ON_ERROR_STOP on
SELECT current_database()='sim_driver_measurements' AS correct_database \gset
\if :correct_database
BEGIN;
TRUNCATE driver_measurement_receipts,driver_measurement_revocations CASCADE;
COMMIT;
\else
\echo Refusing to purge a different database
\quit 3
\endif
