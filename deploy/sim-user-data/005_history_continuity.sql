-- New target witness; immutable and separate from historical CF24 bindings.
BEGIN;
DO $$ BEGIN IF current_database()<>'sim_ai_router' THEN RAISE EXCEPTION 'SIM_HISTORY_DATABASE_REQUIRED'; END IF; END $$;
CREATE TABLE sim_user_history.continuity(singleton boolean PRIMARY KEY CHECK(singleton),contract text NOT NULL CHECK(contract='sim-user-continuity-v1'),guard_store_id uuid NOT NULL,target_store_id uuid NOT NULL,incarnation_id uuid NOT NULL,environment_id uuid NOT NULL,reset_epoch uuid NOT NULL,checkpoint_id uuid NOT NULL,restore_generation bigint NOT NULL CHECK(restore_generation>0),source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),identity_sha256 text NOT NULL CHECK(identity_sha256~'^[a-f0-9]{64}$'));
CREATE FUNCTION sim_user_history.continuity_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'SIM_USER_CONTINUITY_IMMUTABLE'; END $$;
CREATE TRIGGER continuity_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON sim_user_history.continuity FOR EACH STATEMENT EXECUTE FUNCTION sim_user_history.continuity_immutable();
REVOKE ALL ON sim_user_history.continuity FROM PUBLIC;
REVOKE ALL ON FUNCTION sim_user_history.continuity_immutable() FROM PUBLIC;
GRANT SELECT ON sim_user_history.continuity TO ai_router_runtime;
COMMIT;
