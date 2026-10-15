-- SOURCE ONLY: private Root-control observations, not Root admission/activation.
-- No roles, memberships, credentials, checkpoint updates or store adoption.
-- The pre-existing empty private schema and fixed restricted roles are a DBA
-- prerequisite. The binding remains empty: no generated/default incarnation.
-- Caller must use BEGIN READ ONLY as the fixed control session identity.
-- The two legacy checkpoint digests preserve account-erasure.ts exactly.
-- In particular pg_get_triggerdef is visibility-sensitive: fixed
-- search_path=pg_catalog,public preserves the original public-visible rendering.
-- Every relation is explicitly qualified; pg_catalog remains first and neither
-- runtime nor guard/control may CREATE in public. No dynamic SQL or data writes.
BEGIN;
DO $preconditions$
BEGIN
 IF pg_catalog.current_database()<>'sim_ai_router' THEN RAISE EXCEPTION 'dedicated_ai_router_database_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='sim_ai_guard_owner' AND NOT rolcanlogin
   AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='sim_ai_guard_control' AND rolcanlogin
   AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='ai_router_runtime' AND rolcanlogin
   AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='ai_router_migrator')
 THEN RAISE EXCEPTION 'fixed_preexisting_ai_roles_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
   WHERE n.nspname='sim_ai_guard_source' AND r.rolname='sim_ai_guard_owner')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='sim_ai_guard_source')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='sim_ai_guard_source')
 THEN RAISE EXCEPTION 'empty_owned_ai_guard_schema_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member JOIN pg_catalog.pg_roles g ON g.oid=m.roleid
   WHERE r.rolname IN ('sim_ai_guard_owner','sim_ai_guard_control') OR g.rolname IN ('sim_ai_guard_owner','sim_ai_guard_control'))
  OR pg_catalog.pg_has_role('ai_router_runtime','ai_router_migrator','MEMBER')
 THEN RAISE EXCEPTION 'ai_guard_role_isolation_required'; END IF;
 IF pg_catalog.has_schema_privilege('ai_router_runtime','public','CREATE')
  OR pg_catalog.has_schema_privilege('sim_ai_guard_owner','public','CREATE')
  OR pg_catalog.has_schema_privilege('sim_ai_guard_control','public','CREATE')
  OR pg_catalog.has_schema_privilege('ai_router_runtime','sim_ai_guard_source','USAGE,CREATE')
  OR pg_catalog.has_database_privilege('sim_ai_guard_owner',pg_catalog.current_database(),'CREATE,TEMP')
  OR pg_catalog.has_database_privilege('sim_ai_guard_control',pg_catalog.current_database(),'CREATE,TEMP')
 THEN RAISE EXCEPTION 'ai_guard_fixed_private_profile_required'; END IF;
 IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r' AND pg_catalog.pg_get_userbyid(c.relowner)='ai_router_migrator'
    AND c.relname IN ('ai_router_user_key','ai_router_request','ai_router_billing_request','ai_router_user_key_audit',
      'ai_router_account_erasure','ai_router_erasure_checkpoint','ai_router_erased_cost_daily'))<>7
  OR (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='v' AND pg_catalog.pg_get_userbyid(c.relowner)='ai_router_migrator'
    AND c.relname IN ('ai_router_budget_usage','ai_router_billing_usage'))<>2
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('ai_router_erasure_checkpoint','ai_router_account_erasure') AND (c.relrowsecurity OR c.relforcerowsecurity))
  OR (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.oid IN (
    pg_catalog.to_regprocedure('public.ai_router_cop_erasure_fence()'),pg_catalog.to_regprocedure('public.ai_router_erasure_delete_scope(text)'),
    pg_catalog.to_regprocedure('public.ai_router_erasure_operation_immutable()')) AND NOT p.prosecdef AND pg_catalog.pg_get_userbyid(p.proowner)='ai_router_migrator')<>3
 THEN RAISE EXCEPTION 'actual_ai_003_schema_required'; END IF;
END $preconditions$;
GRANT USAGE ON SCHEMA public TO sim_ai_guard_owner;
GRANT SELECT(id,identity_reviewed,replay_ready,cost_policy,checkpoint_id,checkpoint_generation)
 ON public.ai_router_erasure_checkpoint TO sim_ai_guard_owner;
GRANT SELECT(operation_id,owner_hash,target_hash,body_digest,status)
 ON public.ai_router_account_erasure TO sim_ai_guard_owner;
SET ROLE sim_ai_guard_owner;
CREATE TABLE sim_ai_guard_source.store_binding(
 singleton boolean PRIMARY KEY CHECK(singleton),incarnation uuid NOT NULL UNIQUE
);
CREATE FUNCTION sim_ai_guard_source.read_checkpoint_facts(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET TimeZone='UTC' SET row_security=off AS $facts$
DECLARE
 table_names text[]:=ARRAY['ai_router_user_key','ai_router_request','ai_router_billing_request','ai_router_user_key_audit',
   'ai_router_account_erasure','ai_router_erasure_checkpoint','ai_router_erased_cost_daily'];
 role_names text[]:=ARRAY['ai_router_migrator','ai_router_runtime','sim_ai_guard_owner','sim_ai_guard_control'];
 schema_core jsonb; privilege_core jsonb; cp record; cp_value jsonb:='null'::jsonb; expected jsonb;
 store_value uuid; observed timestamptz; bounded boolean:=true; schema_ready boolean:=false; permissions_ready boolean:=false;
 rls_ready boolean:=false; fence_ready boolean:=false; views_ready boolean:=false; retention_ready boolean:=false; snapshot_matches boolean:=false;
 view_names text[]:=ARRAY['ai_router_budget_usage','ai_router_billing_usage'];
 expected_views text[]:=ARRAY[
  'SELECT user_hash,charged_microusd,reserved_microusd,input_tokens::bigint,output_tokens::bigint,created_at,1::bigint AS record_count FROM public.ai_router_request UNION ALL SELECT NULL::text,cost_microusd,cost_microusd,input_tokens,output_tokens,usage_day::timestamp AT TIME ZONE ''UTC'',request_count FROM public.ai_router_erased_cost_daily WHERE billing_lane=''legacy''',
  'SELECT billing_source,payer_hash,actor_hash,estimated_microusd,reserved_microusd,input_tokens::bigint,output_tokens::bigint,created_at,1::bigint AS record_count FROM public.ai_router_billing_request UNION ALL SELECT ''user_openai_key'',NULL::text,NULL::text,cost_microusd,cost_microusd,input_tokens,output_tokens,usage_day::timestamp AT TIME ZONE ''UTC'',request_count FROM public.ai_router_erased_cost_daily WHERE billing_lane=''user_openai_key'''];
 actual_view text; expected_view text; normalized text[]; expression text; i integer; j integer;
BEGIN
 IF pg_catalog.current_database()<>'sim_ai_router' OR session_user<>'sim_ai_guard_control'
 THEN RAISE EXCEPTION 'fixed_ai_control_channel_required'; END IF;
 IF pg_catalog.current_setting('transaction_read_only')<>'on' THEN RAISE EXCEPTION 'ai_read_only_transaction_required'; END IF;
 IF p_request IS NULL OR pg_catalog.jsonb_typeof(p_request)<>'object' OR NOT(p_request ?& ARRAY['owner','scope','purpose','expectedSnapshot'])
  OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_request))<>4
  OR p_request->>'owner'<>'sim_ai_router' OR p_request->>'scope'<>'cop_router_primary_database' OR p_request->>'purpose'<>'checkpoint'
  OR pg_catalog.jsonb_typeof(p_request->'owner') IS DISTINCT FROM 'string' OR pg_catalog.jsonb_typeof(p_request->'scope') IS DISTINCT FROM 'string'
  OR pg_catalog.jsonb_typeof(p_request->'purpose') IS DISTINCT FROM 'string'
 THEN RAISE EXCEPTION 'ai_checkpoint_request_invalid' USING ERRCODE='22023'; END IF;
 expected:=p_request->'expectedSnapshot';
 IF pg_catalog.jsonb_typeof(expected) IS DISTINCT FROM 'object' OR NOT(expected ?& ARRAY['checkpointId','generation','operationDigest','schemaDigest'])
  OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(expected))<>4
  OR pg_catalog.jsonb_typeof(expected->'checkpointId') IS DISTINCT FROM 'string' OR expected->>'checkpointId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR pg_catalog.jsonb_typeof(expected->'generation') IS DISTINCT FROM 'string' OR expected->>'generation' !~ '^(0|[1-9][0-9]{0,18})$'
  OR pg_catalog.jsonb_typeof(expected->'operationDigest') IS DISTINCT FROM 'string' OR expected->>'operationDigest' !~ '^[0-9a-f]{64}$'
  OR pg_catalog.jsonb_typeof(expected->'schemaDigest') IS DISTINCT FROM 'string' OR expected->>'schemaDigest' !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'ai_checkpoint_request_invalid' USING ERRCODE='22023'; END IF;
 IF (expected->>'generation')::numeric>9223372036854775807 THEN RAISE EXCEPTION 'ai_checkpoint_request_invalid' USING ERRCODE='22023'; END IF;

 -- Only bounded catalogs and the existing erasure-ledger digest are read.
 -- No request, billing, credential, audit or financial-rollup rows are queried.
 SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname=ANY(table_names) AND (
   (SELECT count(*) FROM (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LIMIT 129)x)>128
   OR (SELECT count(*) FROM (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid LIMIT 65)x)>64
   OR (SELECT count(*) FROM (SELECT 1 FROM pg_catalog.pg_index ix WHERE ix.indrelid=c.oid LIMIT 33)x)>32
   OR (SELECT count(*) FROM (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid LIMIT 33)x)>32
   OR (SELECT count(*) FROM (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid LIMIT 33)x)>32)) INTO bounded;
 IF NOT bounded
  OR (SELECT count(*) FROM (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND p.proname IN ('ai_router_cop_erasure_fence','ai_router_erasure_delete_scope','ai_router_erasure_operation_immutable') LIMIT 33)x)>32
  OR (SELECT count(*) FROM (SELECT 1 FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'ai_router_%erasure%' LIMIT 129)x)>128
  OR (SELECT count(*) FROM (SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='public' AND p.policyname LIKE 'router_%' LIMIT 129)x)>128
  OR (SELECT count(*) FROM (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member JOIN pg_catalog.pg_roles g ON g.oid=m.roleid
    WHERE r.rolname=ANY(role_names) OR g.rolname=ANY(role_names) LIMIT 65)x)>64
  OR (SELECT count(*) FROM (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='sim_ai_guard_source' LIMIT 9)x)>8
 THEN RAISE EXCEPTION 'ai_checkpoint_catalog_unbounded'; END IF;

 -- Identical existing operation/schema digest expressions. They deliberately
 -- return only digests; the identity-bearing ledger concatenation never leaves.
 SELECT identity_reviewed,replay_ready,cost_policy,checkpoint_id,checkpoint_generation::text,
  (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(operation_id::text || ':' || owner_hash || ':' || target_hash || ':' || body_digest || ':' || status,E'\n' ORDER BY operation_id),''),'UTF8')),'hex') FROM public.ai_router_account_erasure) AS operation_digest,
  (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(definition,E'\n' ORDER BY definition),''),'UTF8')),'hex') FROM (
    SELECT pg_catalog.pg_get_functiondef(oid) AS definition FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('ai_router_cop_erasure_fence','ai_router_erasure_delete_scope','ai_router_erasure_operation_immutable')
    UNION ALL SELECT pg_catalog.pg_get_triggerdef(oid) || ':' || tgenabled::text FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'ai_router_%erasure%'
    UNION ALL SELECT tablename || ':' || policyname || ':' || cmd || ':' || COALESCE(qual,'') || ':' || COALESCE(with_check,'') FROM pg_catalog.pg_policies WHERE schemaname='public' AND policyname LIKE 'router_%'
  ) definitions) AS schema_digest
 INTO cp FROM public.ai_router_erasure_checkpoint WHERE id=1;
 IF FOUND THEN
  cp_value:=pg_catalog.to_jsonb(cp);
  snapshot_matches:=cp.checkpoint_id::text=expected->>'checkpointId' AND cp.checkpoint_generation=expected->>'generation'
    AND cp.operation_digest=expected->>'operationDigest' AND cp.schema_digest=expected->>'schemaDigest';
 END IF;

 SELECT count(*)=4 AND pg_catalog.bool_and(c.relrowsecurity AND NOT pg_catalog.pg_has_role('ai_router_runtime',c.relowner,'MEMBER'))
 INTO rls_ready FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  AND c.relname IN ('ai_router_request','ai_router_billing_request','ai_router_user_key_audit','ai_router_erased_cost_daily');
 SELECT (SELECT count(*) FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND (
  (tgname='ai_router_key_erasure_fence' AND tgrelid='public.ai_router_user_key'::regclass AND tgfoid='public.ai_router_cop_erasure_fence()'::regprocedure) OR
  (tgname='ai_router_request_erasure_fence' AND tgrelid='public.ai_router_request'::regclass AND tgfoid='public.ai_router_cop_erasure_fence()'::regprocedure) OR
  (tgname='ai_router_billing_erasure_fence' AND tgrelid='public.ai_router_billing_request'::regclass AND tgfoid='public.ai_router_cop_erasure_fence()'::regprocedure) OR
  (tgname='ai_router_erasure_operation_guard' AND tgrelid='public.ai_router_account_erasure'::regclass AND tgfoid='public.ai_router_erasure_operation_immutable()'::regprocedure)))=4
  AND (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
    ('ai_router_cop_erasure_fence','ai_router_erasure_delete_scope','ai_router_erasure_operation_immutable') AND NOT prosecdef)=3
 INTO fence_ready;

 -- Presentation-only normalization: exact original UNION ALL column/expression
 -- sequence, rollup lanes, token/cost/reservation fields and UTC dates remain.
 -- It removes qualification/aliases/casts added by pg_get_viewdef, not SQL
 -- operators, branches or predicates. Full original definitions are separately
 -- fingerprinted and must match independent Root pins before use.
 SELECT count(*)=2 AND pg_catalog.bool_and(c.relkind='v' AND pg_catalog.pg_get_userbyid(c.relowner)='ai_router_migrator'
  AND c.reloptions @> ARRAY['security_invoker=true']
  AND ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum)=
    CASE c.relname WHEN 'ai_router_budget_usage' THEN ARRAY['user_hash','charged_microusd','reserved_microusd','input_tokens','output_tokens','created_at','record_count']
      ELSE ARRAY['billing_source','payer_hash','actor_hash','estimated_microusd','reserved_microusd','input_tokens','output_tokens','created_at','record_count'] END
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    AND a.atttypid<>CASE WHEN a.attname='created_at' THEN 'pg_catalog.timestamptz'::regtype
      WHEN a.attname IN ('user_hash','billing_source','payer_hash','actor_hash') THEN 'pg_catalog.text'::regtype ELSE 'pg_catalog.int8'::regtype END)) INTO views_ready
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(view_names);
 FOR i IN 1..2 LOOP
  SELECT pg_catalog.pg_get_viewdef(c.oid,false) INTO actual_view FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='v' AND c.relname=view_names[i];
  expected_view:=expected_views[i];normalized:=ARRAY[]::text[];
  FOR j IN 1..2 LOOP
   expression:=pg_catalog.lower(CASE WHEN j=1 THEN actual_view ELSE expected_view END);
   expression:=pg_catalog.replace(expression,'public.','');
   expression:=pg_catalog.regexp_replace(expression,'\m(ai_router_request|ai_router_billing_request|ai_router_erased_cost_daily)\.','','g');
   expression:=pg_catalog.regexp_replace(expression,'[[:space:]]+as[[:space:]]+(user_hash|charged_microusd|reserved_microusd|input_tokens|output_tokens|created_at|record_count|billing_source|payer_hash|actor_hash|estimated_microusd)\M','','g');
   expression:=pg_catalog.replace(expression,'timestamp without time zone','timestamp');
   expression:=pg_catalog.regexp_replace(expression,'''(legacy|user_openai_key|utc)''::text','''\1''','g');
   normalized:=pg_catalog.array_append(normalized,pg_catalog.regexp_replace(expression,'[[:space:]();]+','','g'));
  END LOOP;
  views_ready:=coalesce(views_ready,false) AND normalized[1] IS NOT NULL AND normalized[1]=normalized[2];
 END LOOP;
 SELECT cp_value->>'cost_policy'='aggregate-costs-current-month-v1'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid='public.ai_router_erased_cost_daily'::regclass AND k.contype='c' AND k.convalidated
    AND pg_catalog.pg_get_constraintdef(k.oid) LIKE '%expires_at%date_trunc%month%usage_day%1 mon%UTC%')
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='public' AND p.tablename='ai_router_erased_cost_daily' AND p.policyname='router_rollup_expiry_delete' AND p.cmd='DELETE'
    AND p.qual LIKE '%expires_at%now()%NOT%EXISTS%ai_router_request%reserved%uncertain%created_at%date_trunc%usage_day%expires_at%'
    AND p.qual LIKE '%NOT%EXISTS%ai_router_billing_request%user_openai_key%cop_chat%reserved%uncertain%created_at%date_trunc%usage_day%expires_at%')
 INTO retention_ready;
 SELECT coalesce(count(*)=7 AND pg_catalog.bool_and(c.relkind='r' AND pg_catalog.pg_get_userbyid(c.relowner)='ai_router_migrator'),false)
  AND coalesce(rls_ready,false) AND coalesce(fence_ready,false) AND coalesce(views_ready,false)
  AND (SELECT count(*)=4 FROM pg_catalog.pg_policies WHERE schemaname='public' AND cmd='DELETE' AND (
    (policyname='router_request_erasure_delete' AND tablename='ai_router_request' AND qual LIKE '%client_id%' AND qual LIKE '%cop%' AND qual LIKE '%ai_router_erasure_delete_scope%') OR
    (policyname='router_billing_erasure_delete' AND tablename='ai_router_billing_request' AND qual LIKE '%user_openai_key%' AND qual LIKE '%cop_chat%' AND qual LIKE '%actor_hash%' AND qual LIKE '%payer_hash%' AND qual LIKE '%ai_router_erasure_delete_scope%') OR
    (policyname='router_key_audit_erasure_delete' AND tablename='ai_router_user_key_audit' AND qual LIKE '%ai_router_erasure_delete_scope%') OR
    (policyname='router_rollup_expiry_delete' AND tablename='ai_router_erased_cost_daily' AND qual LIKE '%expires_at%' AND qual LIKE '%uncertain%')))
 INTO schema_ready FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(table_names);

 SELECT pg_catalog.jsonb_build_object('version','sim-ai-schema-fingerprint-v1','tables',(
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',c.relname,'kind',c.relkind::text,'owner',pg_catalog.pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
   'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
     FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
   'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',k.conname,'validated',k.convalidated,'definition',pg_catalog.pg_get_constraintdef(k.oid)) ORDER BY k.conname) FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),
   'indexes',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_indexdef(ix.indexrelid),'valid',ix.indisvalid,'ready',ix.indisready) ORDER BY ix.indexrelid::regclass::text) FROM pg_catalog.pg_index ix WHERE ix.indrelid=c.oid),
   'policies',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',p.policyname,'permissive',p.permissive,'roles',p.roles,'cmd',p.cmd,'qual',p.qual,'withCheck',p.with_check) ORDER BY p.policyname) FROM pg_catalog.pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname),
   'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',t.tgname,'enabled',t.tgenabled::text,'definition',pg_catalog.pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid)) ORDER BY c.relname)
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(table_names)),
  'views',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',c.relname,'owner',pg_catalog.pg_get_userbyid(c.relowner),'options',c.reloptions,'definition',pg_catalog.pg_get_viewdef(c.oid,false)) ORDER BY c.relname)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(view_names)),
  'legacyFunctions',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',p.proname,'owner',pg_catalog.pg_get_userbyid(p.proowner),'securityDefiner',p.prosecdef,'definition',pg_catalog.pg_get_functiondef(p.oid)) ORDER BY p.oid::regprocedure::text)
    FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('ai_router_cop_erasure_fence','ai_router_erasure_delete_scope','ai_router_erasure_operation_immutable')))
 INTO schema_core;
 SELECT coalesce(pg_catalog.bool_and(pg_catalog.has_table_privilege('ai_router_runtime',t,p))
  AND NOT pg_catalog.has_table_privilege('ai_router_runtime','public.ai_router_account_erasure','DELETE,TRUNCATE')
  AND NOT pg_catalog.has_table_privilege('ai_router_runtime','public.ai_router_erasure_checkpoint','INSERT,UPDATE,DELETE,TRUNCATE')
  AND NOT pg_catalog.has_any_column_privilege('ai_router_runtime','public.ai_router_erasure_checkpoint','INSERT,UPDATE')
  AND NOT pg_catalog.has_schema_privilege('ai_router_runtime','public','CREATE')
  AND NOT pg_catalog.has_database_privilege('ai_router_runtime',pg_catalog.current_database(),'CREATE')
  AND NOT pg_catalog.has_schema_privilege('sim_ai_guard_owner','public','CREATE')
  AND NOT pg_catalog.has_schema_privilege('sim_ai_guard_control','public','CREATE')
  AND NOT pg_catalog.has_database_privilege('sim_ai_guard_owner',pg_catalog.current_database(),'CREATE,TEMP')
  AND NOT pg_catalog.has_database_privilege('sim_ai_guard_control',pg_catalog.current_database(),'CREATE,TEMP')
  AND NOT pg_catalog.has_schema_privilege('ai_router_runtime','sim_ai_guard_source','USAGE,CREATE')
  AND NOT pg_catalog.has_function_privilege('ai_router_runtime','sim_ai_guard_source.read_checkpoint_facts(jsonb)','EXECUTE')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='ai_router_runtime' AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member WHERE r.rolname='ai_router_runtime')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(table_names) AND pg_catalog.pg_has_role('ai_router_runtime',c.relowner,'MEMBER'))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(table_names)
    AND (pg_catalog.has_table_privilege('ai_router_runtime',c.oid,'TRUNCATE,TRIGGER') OR pg_catalog.has_any_column_privilege('ai_router_runtime',c.oid,'REFERENCES')))
  AND pg_catalog.has_sequence_privilege('ai_router_runtime','public.ai_router_user_key_audit_id_seq','USAGE')
  AND pg_catalog.has_sequence_privilege('ai_router_runtime','public.ai_router_user_key_audit_id_seq','SELECT')
  AND coalesce(rls_ready,false),false) INTO permissions_ready
 FROM (VALUES ('public.ai_router_account_erasure','SELECT'),('public.ai_router_account_erasure','INSERT'),('public.ai_router_account_erasure','UPDATE'),
  ('public.ai_router_erased_cost_daily','SELECT'),('public.ai_router_erased_cost_daily','INSERT'),('public.ai_router_erased_cost_daily','UPDATE'),('public.ai_router_erased_cost_daily','DELETE'),
  ('public.ai_router_request','SELECT'),('public.ai_router_request','INSERT'),('public.ai_router_request','UPDATE'),('public.ai_router_request','DELETE'),
  ('public.ai_router_billing_request','SELECT'),('public.ai_router_billing_request','INSERT'),('public.ai_router_billing_request','UPDATE'),('public.ai_router_billing_request','DELETE'),
  ('public.ai_router_user_key_audit','SELECT'),('public.ai_router_user_key_audit','INSERT'),('public.ai_router_user_key_audit','DELETE'),('public.ai_router_user_key','SELECT'),('public.ai_router_user_key','INSERT'),('public.ai_router_user_key','UPDATE'),('public.ai_router_user_key','DELETE'),
  ('public.ai_router_erasure_checkpoint','SELECT'),('public.ai_router_budget_usage','SELECT'),('public.ai_router_billing_usage','SELECT')) rights(t,p);
 SELECT pg_catalog.jsonb_build_object('version','sim-ai-privilege-fingerprint-v1',
  'roles',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',r.rolname,'login',r.rolcanlogin,'inherit',r.rolinherit,'superuser',r.rolsuper,'createDb',r.rolcreatedb,'createRole',r.rolcreaterole,'replication',r.rolreplication,'bypassRls',r.rolbypassrls) ORDER BY r.rolname) FROM pg_catalog.pg_roles r WHERE r.rolname=ANY(role_names)),
  'memberships',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('member',r.rolname,'role',g.rolname,'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) ORDER BY r.rolname,g.rolname)
    FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member JOIN pg_catalog.pg_roles g ON g.oid=m.roleid WHERE r.rolname=ANY(role_names) OR g.rolname=ANY(role_names)),
  'database',(SELECT pg_catalog.jsonb_build_object('owner',pg_catalog.pg_get_userbyid(d.datdba),'acl',d.datacl,'controlCreate',pg_catalog.has_database_privilege('sim_ai_guard_control',d.oid,'CREATE'),'controlTemp',pg_catalog.has_database_privilege('sim_ai_guard_control',d.oid,'TEMP')) FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()),
  'schemas',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',n.nspname,'owner',pg_catalog.pg_get_userbyid(n.nspowner),'acl',n.nspacl,'runtimeCreate',pg_catalog.has_schema_privilege('ai_router_runtime',n.oid,'CREATE'),'runtimeUsage',pg_catalog.has_schema_privilege('ai_router_runtime',n.oid,'USAGE')) ORDER BY n.nspname) FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('public','sim_ai_guard_source')),
  'tables',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',c.relname,'acl',c.relacl,
    'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,'acl',a.attacl,'runtimeSelect',pg_catalog.has_column_privilege('ai_router_runtime',c.oid,a.attnum,'SELECT'),'runtimeInsert',pg_catalog.has_column_privilege('ai_router_runtime',c.oid,a.attnum,'INSERT'),'runtimeUpdate',pg_catalog.has_column_privilege('ai_router_runtime',c.oid,a.attnum,'UPDATE'),'runtimeReferences',pg_catalog.has_column_privilege('ai_router_runtime',c.oid,a.attnum,'REFERENCES')) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)) ORDER BY c.relname)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (c.relname=ANY(table_names) OR c.relname=ANY(view_names))),
  'privateFunctions',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',p.proname,'arguments',pg_catalog.pg_get_function_identity_arguments(p.oid),'owner',pg_catalog.pg_get_userbyid(p.proowner),'securityDefiner',p.prosecdef,'volatility',p.provolatile::text,'config',p.proconfig,'acl',p.proacl,'definitionDigest',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex')) ORDER BY p.oid::regprocedure::text)
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='sim_ai_guard_source')) INTO privilege_core;
 SELECT incarnation INTO store_value FROM sim_ai_guard_source.store_binding WHERE singleton;
 observed:=pg_catalog.clock_timestamp();
 RETURN pg_catalog.jsonb_build_object('contractVersion','sim-ai-checkpoint-facts-v1','request',p_request,
  'observedAtUTC',pg_catalog.to_char(observed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'storeIncarnation',store_value,
  'checkpoint',cp_value,'snapshotMatches',coalesce(snapshot_matches,false),
  'schema',pg_catalog.jsonb_build_object('ready',coalesce(schema_ready,false),'fingerprint',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(schema_core::text,'UTF8')),'hex')),
  'permissions',pg_catalog.jsonb_build_object('runtimeProfileMatches',coalesce(permissions_ready,false),'fingerprint',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(privilege_core::text,'UTF8')),'hex')),
  'invariants',pg_catalog.jsonb_build_object('rlsEnabled',coalesce(rls_ready,false),'fencesReady',coalesce(fence_ready,false),'financialViewsReady',coalesce(views_ready,false),'costRetentionReady',coalesce(retention_ready,false)));
END $facts$;
REVOKE ALL ON sim_ai_guard_source.store_binding FROM PUBLIC,ai_router_runtime,sim_ai_guard_control;
REVOKE ALL ON FUNCTION sim_ai_guard_source.read_checkpoint_facts(jsonb) FROM PUBLIC,ai_router_runtime,sim_ai_guard_control;
GRANT USAGE ON SCHEMA sim_ai_guard_source TO sim_ai_guard_control;
GRANT EXECUTE ON FUNCTION sim_ai_guard_source.read_checkpoint_facts(jsonb) TO sim_ai_guard_control;
RESET ROLE;
COMMIT;
