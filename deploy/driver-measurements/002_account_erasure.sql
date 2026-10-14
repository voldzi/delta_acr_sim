-- Migration owner only in the dedicated driver database. No runtime DDL/functions.
-- Defaults are quarantined; state may be reviewed only by the database owner.
BEGIN;
DO $database$ BEGIN
 IF current_database()<>'sim_driver_measurements' THEN RAISE EXCEPTION 'Dedicated driver database required'; END IF;
END $database$;
CREATE TABLE IF NOT EXISTS driver_account_erasure_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 replay_ready boolean NOT NULL DEFAULT false,
 replay_checkpoint_hash char(64) CHECK(replay_checkpoint_hash ~ '^[a-f0-9]{64}$'),
 proof_valid_until timestamptz,
 retention_reviewed boolean NOT NULL DEFAULT false,
 report_protection text NOT NULL DEFAULT 'unverified' CHECK(report_protection IN ('unverified','no_report','enforced_single_writer','shared_generation_fence')),
 publication_fence_verified boolean NOT NULL DEFAULT false,
 CHECK(NOT publication_fence_verified OR report_protection<>'unverified')
);
INSERT INTO driver_account_erasure_state(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS driver_account_erasure_operations (
 operation_hash char(64) PRIMARY KEY CHECK(operation_hash ~ '^[a-f0-9]{64}$'),
 actor_hash char(64) NOT NULL CHECK(actor_hash ~ '^[a-f0-9]{64}$'),
 request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 contributor_count integer NOT NULL CHECK(contributor_count BETWEEN 9 AND 40),
 deleted_batch_count integer NOT NULL DEFAULT 0 CHECK(deleted_batch_count>=0),
 remaining_batch_count integer NOT NULL DEFAULT 0 CHECK(remaining_batch_count>=0),
 database_zero_verified boolean NOT NULL DEFAULT false, derived_report_acknowledged boolean NOT NULL DEFAULT false,
 replay_checkpoint_hash char(64) CHECK(replay_checkpoint_hash ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
 CHECK(status<>'completed' OR (remaining_batch_count=0 AND database_zero_verified AND derived_report_acknowledged AND replay_checkpoint_hash IS NOT NULL))
);
-- No operation/account/day FK: the fence cannot reconstruct an account's daily identities.
CREATE TABLE IF NOT EXISTS driver_account_erasure_revocations (
 owner text NOT NULL CHECK(owner='cop'), contributor_hash char(64) NOT NULL CHECK(contributor_hash ~ '^[a-f0-9]{64}$'),
 revoked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,contributor_hash)
);
-- Invoker privileges only. An older application cannot silently write after a fence.
CREATE OR REPLACE FUNCTION driver_account_erasure_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $guard$
BEGIN
 -- driver-account-erasure-receipt-guard-v1
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.owner||':'||NEW.contributor_hash,0));
 IF EXISTS(SELECT 1 FROM public.driver_account_erasure_revocations WHERE owner=NEW.owner AND contributor_hash=NEW.contributor_hash) THEN
  RAISE EXCEPTION 'DRIVER_CONSENT_REVOKED' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM public.driver_account_erasure_operations) OR EXISTS(SELECT 1 FROM public.driver_account_erasure_revocations) THEN
  IF current_setting('sim.driver_erasure_context',true) IS DISTINCT FROM 'driver-account-erasure-v1' OR NOT EXISTS(
    SELECT 1 FROM public.driver_account_erasure_state WHERE singleton=true AND replay_ready AND proof_valid_until>now()
      AND replay_checkpoint_hash=current_setting('sim.driver_erasure_checkpoint',true)) THEN
   RAISE EXCEPTION 'DRIVER_ACCOUNT_ERASURE_REPLAY_REQUIRED' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $guard$;
DROP TRIGGER IF EXISTS driver_account_erasure_receipt_guard ON driver_measurement_receipts;
CREATE TRIGGER driver_account_erasure_receipt_guard BEFORE INSERT OR UPDATE ON driver_measurement_receipts
FOR EACH ROW EXECUTE FUNCTION driver_account_erasure_receipt_guard();
REVOKE ALL ON FUNCTION driver_account_erasure_receipt_guard() FROM PUBLIC;
REVOKE ALL ON driver_account_erasure_state,driver_account_erasure_operations,driver_account_erasure_revocations FROM PUBLIC;
-- Never remove erasure evidence during the seven-day measurement cleanup.
-- Any future expiry requires a reviewed authoritative replay/backup retention policy.
DO $grant$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='driver_measurements_runtime') THEN
  GRANT SELECT ON driver_account_erasure_state TO driver_measurements_runtime;
  GRANT SELECT,INSERT,UPDATE ON driver_account_erasure_operations TO driver_measurements_runtime;
  GRANT SELECT,INSERT ON driver_account_erasure_revocations TO driver_measurements_runtime;
  GRANT EXECUTE ON FUNCTION driver_account_erasure_receipt_guard() TO driver_measurements_runtime;
 END IF;
END $grant$;
COMMIT;
