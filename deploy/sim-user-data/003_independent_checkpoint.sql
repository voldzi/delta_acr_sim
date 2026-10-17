-- NEW checkpoint contract only. Does not alter any CF24/v1 table or binding.
BEGIN;
DO $$ BEGIN IF current_database()<>'cop_account_safety_guard' THEN RAISE EXCEPTION 'SIM_USER_INDEPENDENT_DATABASE_REQUIRED'; END IF; END $$;
CREATE SCHEMA IF NOT EXISTS sim_erasure_guard_v2;
REVOKE ALL ON SCHEMA sim_erasure_guard_v2 FROM PUBLIC;
CREATE TABLE sim_erasure_guard_v2.user_data_checkpoint (
 component text PRIMARY KEY CHECK(component IN('sim_user_data','sim_user_history')),
 contract text NOT NULL CHECK(contract='sim-user-continuity-v1'),
 guard_store_id uuid NOT NULL,target_store_id uuid NOT NULL,incarnation_id uuid NOT NULL,
 environment_id uuid NOT NULL,reset_epoch uuid NOT NULL,checkpoint_id uuid NOT NULL,
 restore_generation bigint NOT NULL CHECK(restore_generation>0),source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),identity_sha256 text NOT NULL CHECK(identity_sha256~'^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN('ready','quarantined'))
);
CREATE TABLE sim_erasure_guard_v2.user_data_tombstone (
 component text NOT NULL REFERENCES sim_erasure_guard_v2.user_data_checkpoint,
 owner_key text NOT NULL CHECK(owner_key~'^[a-f0-9]{64}$'),operation_id uuid NOT NULL,
 requested_at timestamptz NOT NULL,oidc_iat bigint NOT NULL CHECK(oidc_iat>0),reset_epoch uuid NOT NULL,
 PRIMARY KEY(component,owner_key),UNIQUE(component,operation_id)
);
CREATE FUNCTION sim_erasure_guard_v2.user_data_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'SIM_USER_CONTINUITY_IMMUTABLE'; END $$;
CREATE TRIGGER user_data_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON sim_erasure_guard_v2.user_data_tombstone FOR EACH STATEMENT EXECUTE FUNCTION sim_erasure_guard_v2.user_data_immutable();
REVOKE ALL ON sim_erasure_guard_v2.user_data_checkpoint,sim_erasure_guard_v2.user_data_tombstone FROM PUBLIC;
REVOKE ALL ON FUNCTION sim_erasure_guard_v2.user_data_immutable() FROM PUBLIC;
ALTER TABLE sim_erasure_guard_v2.user_data_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE sim_erasure_guard_v2.user_data_tombstone ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM(VALUES('sim_user_data','sim_user_data_guard_runtime'),('sim_user_history','sim_user_history_guard_runtime')) AS x(component,role_name) LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r.role_name) THEN
   EXECUTE format('GRANT USAGE ON SCHEMA sim_erasure_guard_v2 TO %I',r.role_name);
   EXECUTE format('GRANT SELECT ON sim_erasure_guard_v2.user_data_checkpoint,sim_erasure_guard_v2.user_data_tombstone TO %I',r.role_name);
   EXECUTE format('GRANT INSERT ON sim_erasure_guard_v2.user_data_tombstone TO %I',r.role_name);
   -- SELECT FOR SHARE requires UPDATE privilege, but RLS has no UPDATE policy.
   EXECUTE format('GRANT UPDATE ON sim_erasure_guard_v2.user_data_checkpoint TO %I',r.role_name);
   EXECUTE format('CREATE POLICY %I ON sim_erasure_guard_v2.user_data_checkpoint FOR SELECT TO %I USING(component=%L)',r.role_name,r.role_name,r.component);
   EXECUTE format('CREATE POLICY %I ON sim_erasure_guard_v2.user_data_tombstone TO %I USING(component=%L) WITH CHECK(component=%L)',r.role_name,r.role_name,r.component,r.component);
  END IF;
 END LOOP;
END $$;
-- Enrollment/grants are a separate explicit controller operation, never runtime.
COMMIT;
