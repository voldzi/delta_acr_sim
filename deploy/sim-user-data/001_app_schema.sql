-- Explicit owner migration in dedicated NEW sim_user_data database only.
BEGIN;
DO $$ BEGIN IF current_database()<>'sim_user_data' THEN RAISE EXCEPTION 'SIM_USER_DATA_DATABASE_REQUIRED'; END IF; END $$;
CREATE SCHEMA sim_user_data;
REVOKE ALL ON SCHEMA sim_user_data FROM PUBLIC;
CREATE TABLE sim_user_data.config(singleton boolean PRIMARY KEY CHECK(singleton),contract text NOT NULL CHECK(contract='cop-sim-user-data-v1'),mode text NOT NULL CHECK(mode IN('isolated-sim-user-data-v1','production-sim-user-data-v1')),environment_id uuid NOT NULL,reset_epoch uuid NOT NULL,tokens_not_before bigint NOT NULL CHECK(tokens_not_before>0));
CREATE TABLE sim_user_data.account(owner_key text PRIMARY KEY CHECK(owner_key~'^[a-f0-9]{64}$'),reset_epoch uuid NOT NULL,state text NOT NULL DEFAULT 'active' CHECK(state IN('active','deletion_pending','deleted')),initialized boolean NOT NULL DEFAULT false,initialization_id uuid NOT NULL DEFAULT gen_random_uuid());
CREATE TABLE sim_user_data.job(owner_key text PRIMARY KEY REFERENCES sim_user_data.account,operation_id uuid UNIQUE NOT NULL,requested_at timestamptz NOT NULL,oidc_iat bigint NOT NULL CHECK(oidc_iat>0),app_store text NOT NULL DEFAULT 'pending' CHECK(app_store IN('pending','deleted')),audit_and_publisher text NOT NULL DEFAULT 'pending' CHECK(audit_and_publisher IN('pending','deleted')),router_sim_history text NOT NULL DEFAULT 'pending' CHECK(router_sim_history IN('pending','deleted')));
CREATE FUNCTION sim_user_data.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='config' THEN RAISE EXCEPTION 'IMMUTABLE_SIM_USER_CONFIG'; END IF;
 IF TG_TABLE_NAME='account' THEN
  IF NEW.owner_key<>OLD.owner_key OR NEW.reset_epoch<>OLD.reset_epoch OR NEW.initialization_id<>OLD.initialization_id OR (OLD.state<>'active' AND NEW.state='active') OR (OLD.state='deleted' AND NEW.state<>'deleted') OR(OLD.initialized AND NOT NEW.initialized) THEN RAISE EXCEPTION 'IMMUTABLE_SIM_USER_ACCOUNT'; END IF;
 ELSIF TG_TABLE_NAME='job' THEN
  IF NEW.owner_key<>OLD.owner_key OR NEW.operation_id<>OLD.operation_id OR NEW.requested_at<>OLD.requested_at OR NEW.oidc_iat<>OLD.oidc_iat OR(OLD.app_store='deleted' AND NEW.app_store<>'deleted') OR(OLD.audit_and_publisher='deleted' AND NEW.audit_and_publisher<>'deleted') OR(OLD.router_sim_history='deleted' AND NEW.router_sim_history<>'deleted') THEN RAISE EXCEPTION 'IMMUTABLE_SIM_USER_JOB'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER config_immutable BEFORE UPDATE OR DELETE ON sim_user_data.config FOR EACH ROW EXECUTE FUNCTION sim_user_data.immutable();
CREATE TRIGGER account_immutable BEFORE UPDATE ON sim_user_data.account FOR EACH ROW EXECUTE FUNCTION sim_user_data.immutable();
CREATE TRIGGER job_immutable BEFORE UPDATE ON sim_user_data.job FOR EACH ROW EXECUTE FUNCTION sim_user_data.immutable();
REVOKE ALL ON ALL TABLES IN SCHEMA sim_user_data FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sim_user_data FROM PUBLIC;
GRANT USAGE ON SCHEMA sim_user_data TO sim_user_data_runtime;
GRANT SELECT ON sim_user_data.config TO sim_user_data_runtime;
GRANT SELECT,INSERT,UPDATE ON sim_user_data.account,sim_user_data.job TO sim_user_data_runtime;
COMMIT;
