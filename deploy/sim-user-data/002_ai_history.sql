-- NEW SIM canonical history only. Must follow reviewed clean AI enrollment.
BEGIN;
DO $$ BEGIN
 IF current_database()<>'sim_ai_router' OR to_regclass('sim_clean.config') IS NULL THEN RAISE EXCEPTION 'SIM_HISTORY_CLEAN_BASELINE_REQUIRED'; END IF;
 IF EXISTS(SELECT FROM ai_router_request WHERE client_id='sim' AND status IN('reserved','uncertain')) OR EXISTS(SELECT FROM ai_router_billing_request WHERE task_type='sim_izs_summary' AND(status IN('reserved','uncertain') OR billing_source<>'sim_project' OR payer_hash<>'sim_izs_project')) THEN RAISE EXCEPTION 'SIM_HISTORY_UNSETTLED_OR_FOREIGN_PAYER'; END IF;
END $$;
CREATE SCHEMA sim_user_history;REVOKE ALL ON SCHEMA sim_user_history FROM PUBLIC;
CREATE TABLE sim_user_history.config(singleton boolean PRIMARY KEY CHECK(singleton),contract text NOT NULL CHECK(contract='cop-sim-user-data-v1'),mode text NOT NULL CHECK(mode IN('isolated-sim-user-data-v1','production-sim-user-data-v1')),environment_id uuid NOT NULL,reset_epoch uuid NOT NULL,tokens_not_before bigint NOT NULL CHECK(tokens_not_before>0));
CREATE TABLE sim_user_history.account(owner_key text PRIMARY KEY CHECK(owner_key~'^[a-f0-9]{64}$'),reset_epoch uuid NOT NULL,state text NOT NULL DEFAULT 'active' CHECK(state IN('active','deletion_pending','deleted')),initialized boolean NOT NULL DEFAULT false);
CREATE TABLE sim_user_history.job(owner_key text PRIMARY KEY REFERENCES sim_user_history.account,operation_id uuid UNIQUE NOT NULL,requested_at timestamptz NOT NULL,oidc_iat bigint NOT NULL,app_store text NOT NULL DEFAULT 'pending',audit_and_publisher text NOT NULL DEFAULT 'pending',router_sim_history text NOT NULL DEFAULT 'pending');
CREATE TABLE sim_user_history.resource(resource_hash text PRIMARY KEY CHECK(resource_hash~'^[a-f0-9]{64}$'),owner_key text NOT NULL REFERENCES sim_user_history.account,kind text NOT NULL CHECK(kind IN('sim','izs')));
CREATE TABLE sim_user_history.cost_daily(lane text NOT NULL CHECK(lane IN('router','sim_project')),usage_day date NOT NULL,microusd bigint NOT NULL,requests bigint NOT NULL,input_tokens bigint NOT NULL,output_tokens bigint NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(lane,usage_day));
-- Explicit finite legacy TEST reset, after the v1 COP reset and stopped writers.
-- No identity inference or importing a previous operation. Preserve finance only.
INSERT INTO sim_user_history.cost_daily SELECT 'router',(created_at AT TIME ZONE 'UTC')::date,sum(COALESCE(charged_microusd,reserved_microusd,0)),count(*),sum(COALESCE(input_tokens,0)),sum(COALESCE(output_tokens,0)),(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC' FROM ai_router_request WHERE client_id='sim' AND created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' GROUP BY 2;
INSERT INTO sim_user_history.cost_daily SELECT 'sim_project',(created_at AT TIME ZONE 'UTC')::date,sum(COALESCE(estimated_microusd,reserved_microusd,0)),count(*),sum(COALESCE(input_tokens,0)),sum(COALESCE(output_tokens,0)),(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC' FROM ai_router_billing_request WHERE task_type='sim_izs_summary' AND billing_source='sim_project' AND payer_hash='sim_izs_project' AND created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' GROUP BY 2;
DELETE FROM ai_router_request WHERE client_id='sim';
DELETE FROM ai_router_billing_request WHERE task_type='sim_izs_summary' AND billing_source='sim_project' AND payer_hash='sim_izs_project';
CREATE FUNCTION sim_user_history.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_NAME IN('config','resource') THEN RAISE EXCEPTION 'IMMUTABLE_SIM_HISTORY_BINDING'; END IF;
 IF TG_TABLE_NAME='account' THEN
  IF NEW.owner_key<>OLD.owner_key OR NEW.reset_epoch<>OLD.reset_epoch OR(OLD.state<>'active' AND NEW.state='active') OR(OLD.state='deleted' AND NEW.state<>'deleted') THEN RAISE EXCEPTION 'IMMUTABLE_SIM_HISTORY_ACCOUNT'; END IF;
 ELSIF TG_TABLE_NAME='job' THEN
  IF NEW.owner_key<>OLD.owner_key OR NEW.operation_id<>OLD.operation_id OR NEW.requested_at<>OLD.requested_at OR NEW.oidc_iat<>OLD.oidc_iat THEN RAISE EXCEPTION 'IMMUTABLE_SIM_HISTORY_JOB'; END IF;
 END IF;
 RETURN NEW;END $$;
CREATE TRIGGER config_immutable BEFORE UPDATE OR DELETE ON sim_user_history.config FOR EACH ROW EXECUTE FUNCTION sim_user_history.immutable();
CREATE TRIGGER resource_immutable BEFORE UPDATE OR DELETE ON sim_user_history.resource FOR EACH ROW EXECUTE FUNCTION sim_user_history.immutable();
CREATE TRIGGER account_immutable BEFORE UPDATE ON sim_user_history.account FOR EACH ROW EXECUTE FUNCTION sim_user_history.immutable();
CREATE TRIGGER job_immutable BEFORE UPDATE ON sim_user_history.job FOR EACH ROW EXECUTE FUNCTION sim_user_history.immutable();
CREATE FUNCTION sim_user_history.fence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE h text;s text;
BEGIN
 IF TG_TABLE_NAME='ai_router_request' THEN IF NEW.client_id<>'sim' THEN RETURN NEW;END IF;h:=NEW.user_hash;
 ELSE IF NEW.task_type<>'sim_izs_summary' THEN RETURN NEW;END IF;h:=NEW.actor_hash;END IF;
 SELECT a.state INTO s FROM sim_user_history.resource r JOIN sim_user_history.account a USING(owner_key) JOIN sim_user_history.config c ON c.singleton WHERE r.resource_hash=h AND r.kind=CASE WHEN TG_TABLE_NAME='ai_router_request' THEN 'sim' ELSE 'izs' END AND a.reset_epoch=c.reset_epoch FOR SHARE OF a;
 IF s IS NULL OR(s<>'active' AND NOT(TG_OP='UPDATE' AND OLD.status='reserved' AND NEW.status IN('success','failed','uncertain'))) THEN RAISE EXCEPTION 'SIM_HISTORY_FENCED';END IF;
 IF TG_OP='UPDATE' AND to_jsonb(NEW)-ARRAY['status','charged_microusd','estimated_microusd','input_tokens','output_tokens','error_code','completed_at'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','charged_microusd','estimated_microusd','input_tokens','output_tokens','error_code','completed_at'] THEN RAISE EXCEPTION 'IMMUTABLE_SIM_HISTORY_REQUEST';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER sim_history_fence BEFORE INSERT OR UPDATE ON ai_router_request FOR EACH ROW EXECUTE FUNCTION sim_user_history.fence();
CREATE TRIGGER sim_history_fence BEFORE INSERT OR UPDATE ON ai_router_billing_request FOR EACH ROW EXECUTE FUNCTION sim_user_history.fence();
CREATE OR REPLACE VIEW sim_clean.router_usage WITH(security_invoker=true) AS
 SELECT user_hash,charged_microusd,reserved_microusd,input_tokens::bigint,output_tokens::bigint,created_at,1::bigint AS record_count FROM public.ai_router_request
 UNION ALL SELECT NULL::text,microusd,microusd,input_tokens,output_tokens,usage_day::timestamp AT TIME ZONE 'UTC',requests FROM sim_clean.cost_daily WHERE lane='router' AND expires_at>now()
 UNION ALL SELECT NULL::text,microusd,microusd,input_tokens,output_tokens,usage_day::timestamp AT TIME ZONE 'UTC',requests FROM sim_user_history.cost_daily WHERE lane='router' AND expires_at>now();
CREATE OR REPLACE VIEW sim_clean.billing_usage WITH(security_invoker=true) AS
 SELECT billing_source,payer_hash,actor_hash,estimated_microusd,reserved_microusd,input_tokens::bigint,output_tokens::bigint,created_at,1::bigint AS record_count FROM public.ai_router_billing_request
 UNION ALL SELECT 'user_openai_key',NULL::text,NULL::text,microusd,microusd,input_tokens,output_tokens,usage_day::timestamp AT TIME ZONE 'UTC',requests FROM sim_clean.cost_daily WHERE lane='byok' AND expires_at>now()
 UNION ALL SELECT 'sim_project','sim_izs_project',NULL::text,microusd,microusd,input_tokens,output_tokens,usage_day::timestamp AT TIME ZONE 'UTC',requests FROM sim_user_history.cost_daily WHERE lane='sim_project' AND expires_at>now();
REVOKE ALL ON ALL TABLES IN SCHEMA sim_user_history FROM PUBLIC;REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sim_user_history FROM PUBLIC;
GRANT USAGE ON SCHEMA sim_user_history TO ai_router_runtime;
GRANT SELECT ON sim_user_history.config TO ai_router_runtime;
GRANT SELECT,INSERT,UPDATE ON sim_user_history.account,sim_user_history.job,sim_user_history.cost_daily TO ai_router_runtime;
GRANT SELECT,INSERT ON sim_user_history.resource TO ai_router_runtime;
GRANT DELETE ON sim_user_history.cost_daily TO ai_router_runtime;
CREATE POLICY sim_history_request_delete ON public.ai_router_request FOR DELETE TO ai_router_runtime USING(client_id='sim' AND EXISTS(SELECT FROM sim_user_history.resource r JOIN sim_user_history.account a USING(owner_key) WHERE r.resource_hash=user_hash AND a.state='deletion_pending'));
CREATE POLICY sim_history_billing_delete ON public.ai_router_billing_request FOR DELETE TO ai_router_runtime USING(task_type='sim_izs_summary' AND billing_source='sim_project' AND payer_hash='sim_izs_project' AND EXISTS(SELECT FROM sim_user_history.resource r JOIN sim_user_history.account a USING(owner_key) WHERE r.resource_hash=actor_hash AND a.state='deletion_pending'));
COMMIT;
