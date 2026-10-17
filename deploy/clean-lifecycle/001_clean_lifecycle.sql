-- NEW isolated scope only. Apply to a NEW test DB, never to CF24 stores.
BEGIN;
DO $$
DECLARE table_name text; occupied boolean;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['ai_router_request','ai_router_user_key','ai_router_user_key_audit','ai_router_billing_request','driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta','driver_measurement_revocations'] LOOP
   IF to_regclass('public.'||table_name) IS NOT NULL THEN
     EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I)',table_name) INTO occupied;
     IF occupied THEN RAISE EXCEPTION 'CLEAN_BASELINE_NOT_EMPTY'; END IF;
   END IF;
 END LOOP;
END $$;
CREATE SCHEMA sim_clean;
REVOKE ALL ON SCHEMA sim_clean FROM PUBLIC;
CREATE TABLE sim_clean.config (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 contract text NOT NULL CHECK(contract='cop-sim-user-lifecycle-v1'),
 mode text NOT NULL CHECK(mode='isolated-clean-lifecycle-v1'),
 environment_id uuid NOT NULL, reset_epoch uuid NOT NULL,
 lane text NOT NULL CHECK(lane IN ('ai','driver'))
);
-- Enrollment is an explicit owner action. No default epoch or auto-recovery.
CREATE TABLE sim_clean.account (
 owner_key text PRIMARY KEY CHECK(owner_key ~ '^[a-f0-9]{64}$'),
 reset_epoch uuid NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','deletion_pending','deleted')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sim_clean.resource (
 kind text NOT NULL CHECK(kind IN ('ai_hash','driver_contributor')),
 resource_hash text NOT NULL CHECK(resource_hash ~ '^[a-f0-9]{64}$'),
 owner_key text NOT NULL REFERENCES sim_clean.account,
 PRIMARY KEY(kind,resource_hash)
);
CREATE INDEX resource_owner ON sim_clean.resource(owner_key);
CREATE TABLE sim_clean.job (
 operation_id uuid PRIMARY KEY,
 owner_key text UNIQUE NOT NULL REFERENCES sim_clean.account,
 reset_epoch uuid NOT NULL, requested_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 last_code text CHECK(last_code IS NULL OR last_code IN ('IN_FLIGHT','RETRY'))
);
CREATE INDEX pending_jobs ON sim_clean.job(next_attempt_at) WHERE completed_at IS NULL;
CREATE FUNCTION sim_clean.immutable_lifecycle() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,sim_clean AS $$
BEGIN
 IF TG_TABLE_NAME='account' THEN
   IF NEW.owner_key<>OLD.owner_key OR NEW.reset_epoch<>OLD.reset_epoch OR NEW.created_at<>OLD.created_at
   OR NOT (NEW.state=OLD.state OR (OLD.state='active' AND NEW.state='deletion_pending') OR (OLD.state='deletion_pending' AND NEW.state='deleted')) THEN
      RAISE EXCEPTION 'IMMUTABLE_LIFECYCLE';
   END IF;
 ELSIF TG_TABLE_NAME='resource' AND to_jsonb(NEW)<>to_jsonb(OLD) THEN
   RAISE EXCEPTION 'IMMUTABLE_OWNER_BINDING';
 ELSIF TG_TABLE_NAME='job' AND (NEW.operation_id<>OLD.operation_id OR NEW.owner_key<>OLD.owner_key OR NEW.reset_epoch<>OLD.reset_epoch OR NEW.requested_at<>OLD.requested_at
   OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)) THEN
   RAISE EXCEPTION 'IMMUTABLE_OPERATION';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_lifecycle BEFORE UPDATE ON sim_clean.account FOR EACH ROW EXECUTE FUNCTION sim_clean.immutable_lifecycle();
CREATE TRIGGER immutable_owner BEFORE UPDATE ON sim_clean.resource FOR EACH ROW EXECUTE FUNCTION sim_clean.immutable_lifecycle();
CREATE TRIGGER immutable_operation BEFORE UPDATE ON sim_clean.job FOR EACH ROW EXECUTE FUNCTION sim_clean.immutable_lifecycle();
-- Anonymous totals retain caps without a link to the removed owner.
CREATE TABLE sim_clean.cost_daily (
 lane text NOT NULL, usage_day date NOT NULL,
 microusd bigint NOT NULL, requests bigint NOT NULL,
 input_tokens bigint NOT NULL, output_tokens bigint NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(lane,usage_day)
);
CREATE FUNCTION sim_clean.fence() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,sim_clean AS $$
DECLARE h text; k text; s text; epoch uuid; configured uuid;
BEGIN
 -- Triggers are installed only on explicitly listed application user writers.
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)->TG_ARGV[1]) IS DISTINCT FROM (to_jsonb(OLD)->TG_ARGV[1])
 OR (TG_TABLE_NAME='ai_router_request' AND (to_jsonb(NEW)->'client_id') IS DISTINCT FROM (to_jsonb(OLD)->'client_id'))
 OR (TG_TABLE_NAME='ai_router_billing_request' AND (to_jsonb(NEW)->'task_type') IS DISTINCT FROM (to_jsonb(OLD)->'task_type'))) THEN
   RAISE EXCEPTION 'IMMUTABLE_RESOURCE_OWNER';
 END IF;
 IF TG_TABLE_NAME='ai_router_request' AND to_jsonb(NEW)->>'client_id'<>'cop' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='ai_router_billing_request' AND to_jsonb(NEW)->>'task_type'<>'cop_chat' THEN RETURN NEW; END IF;
 h:=to_jsonb(NEW)->>TG_ARGV[1]; k:=TG_ARGV[0];
 SELECT a.state,a.reset_epoch INTO s,epoch FROM sim_clean.resource r
 JOIN sim_clean.account a USING(owner_key)
 WHERE r.kind=k AND r.resource_hash=h FOR SHARE OF a;
 SELECT reset_epoch INTO configured FROM sim_clean.config WHERE singleton;
 -- A pre-fence AI reservation may settle but cannot change its identity,
 -- payload, model or reserved amount. Otherwise pending would never drain.
 IF s='deletion_pending' AND configured IS NOT NULL AND epoch=configured
 AND TG_OP='UPDATE' AND TG_TABLE_NAME IN ('ai_router_request','ai_router_billing_request') THEN
   IF to_jsonb(OLD)->>'status' IN ('reserved','uncertain') AND to_jsonb(NEW)->>'status' IN ('success','failed','uncertain')
   AND (to_jsonb(OLD)-ARRAY['status','charged_microusd','estimated_microusd','input_tokens','output_tokens','completed_at','error_code'])
       = (to_jsonb(NEW)-ARRAY['status','charged_microusd','estimated_microusd','input_tokens','output_tokens','completed_at','error_code']) THEN
      RETURN NEW;
   END IF;
 END IF;
 IF s IS DISTINCT FROM 'active' OR configured IS NULL OR epoch IS DISTINCT FROM configured THEN
   RAISE EXCEPTION 'CLEAN_ACCOUNT_FENCED' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA sim_clean FROM PUBLIC;
REVOKE ALL ON FUNCTION sim_clean.fence() FROM PUBLIC;
COMMIT;
