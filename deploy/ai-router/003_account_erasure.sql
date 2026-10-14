-- Owner-reviewed isolated Router migration; no SECURITY DEFINER/runtime DDL.
BEGIN;
DO $$ BEGIN IF current_database()<>'sim_ai_router' THEN RAISE EXCEPTION 'AI Router migration requires sim_ai_router'; END IF; END $$;
CREATE TABLE IF NOT EXISTS ai_router_erasure_checkpoint (
 id integer PRIMARY KEY CHECK(id=1),schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1),
 identity_reviewed boolean NOT NULL DEFAULT false,replay_ready boolean NOT NULL DEFAULT false,
 cost_policy text NOT NULL DEFAULT 'pending_requires_review' CHECK(cost_policy IN ('pending_requires_review','aggregate-costs-current-month-v1')),
 checkpoint_id uuid NOT NULL,checkpoint_generation bigint NOT NULL DEFAULT 0 CHECK(checkpoint_generation>=0),updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_router_erasure_checkpoint(id,checkpoint_id) VALUES(1,gen_random_uuid()) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS ai_router_account_erasure (
 operation_id uuid PRIMARY KEY,owner_hash text NOT NULL CHECK(owner_hash~'^[a-f0-9]{64}$'),target_hash text NOT NULL UNIQUE CHECK(target_hash~'^[a-f0-9]{64}$'),
 namespace text NOT NULL DEFAULT 'cop' CHECK(namespace='cop'),hash_version integer NOT NULL DEFAULT 1 CHECK(hash_version=1),body_digest text NOT NULL CHECK(body_digest~'^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','online_complete')),requested_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 reviewed_cost_policy text CHECK(reviewed_cost_policy='aggregate-costs-current-month-v1'),
 CHECK((status='pending' AND completed_at IS NULL) OR (status='online_complete' AND completed_at IS NOT NULL AND reviewed_cost_policy IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS ai_router_erased_cost_daily (
 billing_lane text NOT NULL CHECK(billing_lane IN ('legacy','user_openai_key')),usage_day date NOT NULL,cost_microusd bigint NOT NULL CHECK(cost_microusd>=0),
 request_count bigint NOT NULL CHECK(request_count>=0),input_tokens bigint NOT NULL CHECK(input_tokens>=0),output_tokens bigint NOT NULL CHECK(output_tokens>=0),expires_at timestamptz NOT NULL,
 PRIMARY KEY(billing_lane,usage_day),CHECK(expires_at=(date_trunc('month',usage_day::timestamp)+interval '1 month') AT TIME ZONE 'UTC')
);
ALTER TABLE ai_router_request DROP CONSTRAINT IF EXISTS ai_router_request_status_check;
ALTER TABLE ai_router_request ADD CONSTRAINT ai_router_request_status_check CHECK(status IN ('reserved','success','failed','uncertain'));
CREATE OR REPLACE VIEW ai_router_budget_usage WITH(security_invoker=true) AS
 SELECT user_hash,charged_microusd,reserved_microusd,input_tokens::bigint,output_tokens::bigint,created_at,1::bigint AS record_count FROM ai_router_request
 UNION ALL SELECT NULL::text,cost_microusd,cost_microusd,input_tokens,output_tokens,usage_day::timestamp AT TIME ZONE 'UTC',request_count FROM ai_router_erased_cost_daily WHERE billing_lane='legacy';
CREATE OR REPLACE VIEW ai_router_billing_usage WITH(security_invoker=true) AS
 SELECT billing_source,payer_hash,actor_hash,estimated_microusd,reserved_microusd,input_tokens::bigint,output_tokens::bigint,created_at,1::bigint AS record_count FROM ai_router_billing_request
 UNION ALL SELECT 'user_openai_key',NULL::text,NULL::text,cost_microusd,cost_microusd,input_tokens,output_tokens,usage_day::timestamp AT TIME ZONE 'UTC',request_count FROM ai_router_erased_cost_daily WHERE billing_lane='user_openai_key';
CREATE OR REPLACE FUNCTION ai_router_cop_erasure_fence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE target text;
BEGIN
 IF TG_TABLE_NAME='ai_router_user_key' THEN target:=NEW.user_hash;
 ELSIF TG_TABLE_NAME='ai_router_request' THEN IF NEW.client_id='cop' THEN target:=NEW.user_hash; ELSE RETURN NEW; END IF;
 ELSIF TG_TABLE_NAME='ai_router_billing_request' THEN IF NEW.billing_source='user_openai_key' THEN target:=NEW.actor_hash; ELSE RETURN NEW; END IF;
 ELSE RETURN NEW; END IF;
 IF TG_TABLE_NAME IN ('ai_router_request','ai_router_billing_request') AND current_setting('sim.router_erasure_code_version',true) IS DISTINCT FROM '1' THEN
  RAISE EXCEPTION 'erasure_incompatible_runtime' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(634020,hashtext(target));
 IF EXISTS(SELECT 1 FROM public.ai_router_account_erasure WHERE target_hash=target) THEN RAISE EXCEPTION 'account_erasure_pending' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_router_key_erasure_fence ON ai_router_user_key;
CREATE TRIGGER ai_router_key_erasure_fence BEFORE INSERT OR UPDATE ON ai_router_user_key FOR EACH ROW EXECUTE FUNCTION ai_router_cop_erasure_fence();
DROP TRIGGER IF EXISTS ai_router_request_erasure_fence ON ai_router_request;
CREATE TRIGGER ai_router_request_erasure_fence BEFORE INSERT ON ai_router_request FOR EACH ROW EXECUTE FUNCTION ai_router_cop_erasure_fence();
DROP TRIGGER IF EXISTS ai_router_billing_erasure_fence ON ai_router_billing_request;
CREATE TRIGGER ai_router_billing_erasure_fence BEFORE INSERT ON ai_router_billing_request FOR EACH ROW EXECUTE FUNCTION ai_router_cop_erasure_fence();
CREATE OR REPLACE FUNCTION ai_router_erasure_delete_scope(target text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT target=current_setting('sim.erasure_target',true) AND EXISTS(SELECT 1 FROM public.ai_router_account_erasure WHERE target_hash=target AND status='pending'
 AND operation_id::text=current_setting('sim.erasure_operation',true) AND owner_hash=current_setting('sim.erasure_owner',true))
$$;
CREATE OR REPLACE FUNCTION ai_router_erasure_operation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.operation_id<>OLD.operation_id OR NEW.owner_hash<>OLD.owner_hash OR NEW.target_hash<>OLD.target_hash OR NEW.namespace<>OLD.namespace
 OR NEW.hash_version<>OLD.hash_version OR NEW.body_digest<>OLD.body_digest OR NEW.requested_at<>OLD.requested_at OR
 (OLD.status='online_complete' AND (NEW.status<>OLD.status OR NEW.completed_at<>OLD.completed_at OR NEW.reviewed_cost_policy<>OLD.reviewed_cost_policy)) THEN
  RAISE EXCEPTION 'erasure_fence_immutable'; END IF;
 IF OLD.status='pending' AND NEW.status='online_complete' AND (
  NOT public.ai_router_erasure_delete_scope(OLD.target_hash) OR
  EXISTS(SELECT 1 FROM public.ai_router_request WHERE client_id='cop' AND user_hash=OLD.target_hash) OR
  EXISTS(SELECT 1 FROM public.ai_router_billing_request WHERE billing_source='user_openai_key' AND (actor_hash=OLD.target_hash OR payer_hash=OLD.target_hash)) OR
  EXISTS(SELECT 1 FROM public.ai_router_user_key WHERE user_hash=OLD.target_hash) OR EXISTS(SELECT 1 FROM public.ai_router_user_key_audit WHERE user_hash=OLD.target_hash)) THEN
  RAISE EXCEPTION 'erasure_zero_not_verified'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_router_erasure_operation_guard ON ai_router_account_erasure;
CREATE TRIGGER ai_router_erasure_operation_guard BEFORE UPDATE ON ai_router_account_erasure FOR EACH ROW EXECUTE FUNCTION ai_router_erasure_operation_immutable();
ALTER TABLE ai_router_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_router_billing_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_router_user_key_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS router_request_read ON ai_router_request;
CREATE POLICY router_request_read ON ai_router_request FOR SELECT TO ai_router_runtime USING(true);
DROP POLICY IF EXISTS router_request_insert ON ai_router_request;
CREATE POLICY router_request_insert ON ai_router_request FOR INSERT TO ai_router_runtime WITH CHECK(true);
DROP POLICY IF EXISTS router_request_update ON ai_router_request;
CREATE POLICY router_request_update ON ai_router_request FOR UPDATE TO ai_router_runtime USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS router_request_erasure_delete ON ai_router_request;
CREATE POLICY router_request_erasure_delete ON ai_router_request FOR DELETE TO ai_router_runtime USING(client_id='cop' AND public.ai_router_erasure_delete_scope(user_hash));
DROP POLICY IF EXISTS router_billing_read ON ai_router_billing_request;
CREATE POLICY router_billing_read ON ai_router_billing_request FOR SELECT TO ai_router_runtime USING(true);
DROP POLICY IF EXISTS router_billing_insert ON ai_router_billing_request;
CREATE POLICY router_billing_insert ON ai_router_billing_request FOR INSERT TO ai_router_runtime WITH CHECK(true);
DROP POLICY IF EXISTS router_billing_update ON ai_router_billing_request;
CREATE POLICY router_billing_update ON ai_router_billing_request FOR UPDATE TO ai_router_runtime USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS router_billing_erasure_delete ON ai_router_billing_request;
CREATE POLICY router_billing_erasure_delete ON ai_router_billing_request FOR DELETE TO ai_router_runtime USING(billing_source='user_openai_key' AND task_type='cop_chat' AND actor_hash=payer_hash AND public.ai_router_erasure_delete_scope(actor_hash));
DROP POLICY IF EXISTS router_key_audit_read ON ai_router_user_key_audit;
CREATE POLICY router_key_audit_read ON ai_router_user_key_audit FOR SELECT TO ai_router_runtime USING(true);
DROP POLICY IF EXISTS router_key_audit_insert ON ai_router_user_key_audit;
CREATE POLICY router_key_audit_insert ON ai_router_user_key_audit FOR INSERT TO ai_router_runtime WITH CHECK(true);
DROP POLICY IF EXISTS router_key_audit_erasure_delete ON ai_router_user_key_audit;
CREATE POLICY router_key_audit_erasure_delete ON ai_router_user_key_audit FOR DELETE TO ai_router_runtime USING(public.ai_router_erasure_delete_scope(user_hash));
ALTER TABLE ai_router_erased_cost_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS router_rollup_read ON ai_router_erased_cost_daily;
CREATE POLICY router_rollup_read ON ai_router_erased_cost_daily FOR SELECT TO ai_router_runtime USING(true);
DROP POLICY IF EXISTS router_rollup_insert ON ai_router_erased_cost_daily;
CREATE POLICY router_rollup_insert ON ai_router_erased_cost_daily FOR INSERT TO ai_router_runtime WITH CHECK(true);
DROP POLICY IF EXISTS router_rollup_update ON ai_router_erased_cost_daily;
CREATE POLICY router_rollup_update ON ai_router_erased_cost_daily FOR UPDATE TO ai_router_runtime USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS router_rollup_expiry_delete ON ai_router_erased_cost_daily;
CREATE POLICY router_rollup_expiry_delete ON ai_router_erased_cost_daily FOR DELETE TO ai_router_runtime USING(expires_at<=now()
 AND NOT EXISTS(SELECT 1 FROM public.ai_router_request r WHERE billing_lane='legacy' AND r.client_id='cop' AND r.status IN ('reserved','uncertain') AND r.created_at>=date_trunc('month',usage_day::timestamp) AT TIME ZONE 'UTC' AND r.created_at<expires_at)
 AND NOT EXISTS(SELECT 1 FROM public.ai_router_billing_request r WHERE billing_lane='user_openai_key' AND r.billing_source='user_openai_key' AND r.task_type='cop_chat' AND r.status IN ('reserved','uncertain') AND r.created_at>=date_trunc('month',usage_day::timestamp) AT TIME ZONE 'UTC' AND r.created_at<expires_at));
REVOKE ALL ON ai_router_account_erasure,ai_router_erasure_checkpoint,ai_router_erased_cost_daily,ai_router_budget_usage,ai_router_billing_usage FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_router_cop_erasure_fence(),ai_router_erasure_delete_scope(text),ai_router_erasure_operation_immutable() FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON ai_router_account_erasure,ai_router_erased_cost_daily TO ai_router_runtime;
GRANT SELECT ON ai_router_erasure_checkpoint,ai_router_budget_usage,ai_router_billing_usage TO ai_router_runtime;
GRANT SELECT,DELETE ON ai_router_user_key_audit TO ai_router_runtime;
GRANT DELETE ON ai_router_request,ai_router_billing_request,ai_router_erased_cost_daily TO ai_router_runtime;
GRANT EXECUTE ON FUNCTION ai_router_cop_erasure_fence(),ai_router_erasure_delete_scope(text),ai_router_erasure_operation_immutable() TO ai_router_runtime;
-- No runtime DELETE on permanent fences/checkpoint; no checkpoint UPDATE.
COMMIT;
