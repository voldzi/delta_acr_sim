-- SOURCE ONLY: protected Root-control read facts, not admission or activation.
-- Frozen 003/schema/expiry artifacts are not replaced. No role/membership/table
-- mutation, origin probe, lock, seal, DML, publication claim or provider call.
-- The caller supplies BEGIN READ ONLY; this STABLE function uses one statement
-- snapshot. Root separately verifies signed/current references and locked policy.
-- Fingerprints are PG SHA256 of UTF8 JSONB::text, not JSON.stringify hashes:
-- schema core v1 = seven named tables' actual owner/RLS/columns/defaults,
-- constraints/indexes/triggers plus the original receipt-guard definition.
-- privilege core v1 = actual fixed roles/memberships, DB/schema/table/column
-- ACLs, effective runtime rights (including PUBLIC column rights), and bounded
-- guarded-function identity/owner/config/ACL/body digests. No raw SQL/ACL leaves
-- the function. Core arrays are sorted and bounded; exceeding a cap is not ready.
BEGIN;
DO $preconditions$
BEGIN
 IF current_database()<>'sim_driver_measurements' THEN RAISE EXCEPTION 'dedicated_driver_database_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sim_driver_guard_owner'
   AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
   AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sim_driver_guard_control'
   AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
   AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
   WHERE n.nspname='sim_driver_guard_source' AND r.rolname='sim_driver_guard_owner')
 THEN RAISE EXCEPTION 'owned_guard_source_required'; END IF;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='sim_driver_guard_source' AND p.prosecdef AND pg_get_userbyid(p.proowner)='sim_driver_guard_owner'
     AND p.oid IN (to_regprocedure('sim_driver_guard_source.register_origin(uuid,uuid,uuid,text,text,text,timestamptz)'),
       to_regprocedure('sim_driver_guard_source.claim_origin(uuid,uuid,xid8,integer,timestamptz)'),
       to_regprocedure('sim_driver_guard_source.execute_origin(uuid,jsonb)'),
       to_regprocedure('sim_driver_guard_source.resolve_or_seal(uuid)'),
       to_regprocedure('sim_driver_guard_source.read_publication_context(uuid,jsonb)')))<>5
  OR to_regclass('sim_driver_guard_source.store_binding') IS NULL
 THEN RAISE EXCEPTION 'guarded_003_source_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='sim_driver_guard_source' AND p.proname='read_admission_facts')
 THEN RAISE EXCEPTION 'existing_read_facts_not_adopted'; END IF;
END $preconditions$;
SET ROLE sim_driver_guard_owner;
CREATE FUNCTION sim_driver_guard_source.read_admission_facts(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog SET TimeZone='UTC' SET row_security=off AS $facts$
DECLARE
 table_names text[]:=ARRAY['driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta',
   'driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations'];
 role_names text[]:=ARRAY['driver_measurements_migrator','driver_measurements_runtime','sim_driver_guard_owner','sim_driver_guard_control','sim_driver_guard_exec'];
 expected_columns jsonb:='{"driver_measurement_receipts":["owner","batch_id","contributor_hash","request_hash","received_at","expires_at","receipt"],"driver_measurement_intervals":["owner","batch_id","measurement_key","dataset","edge_id","window_start","speed_kph","distance_m","elapsed_seconds"],"driver_measurement_eta":["owner","batch_id","observation_id","contributor_hash","dataset","window_start","predicted_seconds","actual_seconds"],"driver_measurement_revocations":["owner","contributor_hash","expires_at"],"driver_account_erasure_state":["singleton","replay_ready","replay_checkpoint_hash","proof_valid_until","retention_reviewed","report_protection","publication_fence_verified"],"driver_account_erasure_operations":["operation_hash","actor_hash","request_hash","created_at","updated_at","contributor_count","deleted_batch_count","remaining_batch_count","database_zero_verified","derived_report_acknowledged","replay_checkpoint_hash","status"],"driver_account_erasure_revocations":["owner","contributor_hash","revoked_at"]}'::jsonb;
 required_keys text[]; purpose text; schema_tables jsonb; original_guard jsonb;
 schema_core jsonb; privilege_core jsonb; schema_ready boolean:=false; profile_matches boolean:=false;
 ledger_indexed boolean:=false; bounded boolean:=true; store_value uuid; state_row record; ledger record;
 state_value jsonb; operation_value jsonb:='null'::jsonb; observed timestamptz; proof_until timestamptz;
 checkpoint text; protection text:='unverified'; replay_ready boolean:=false; retention_reviewed boolean:=false; publication_verified boolean:=false;
BEGIN
 IF current_database()<>'sim_driver_measurements' OR session_user<>'sim_driver_guard_control'
 THEN RAISE EXCEPTION 'fixed_control_channel_required'; END IF;
 IF current_setting('transaction_read_only')<>'on' THEN RAISE EXCEPTION 'read_only_transaction_required'; END IF;
 IF p_request IS NULL OR jsonb_typeof(p_request)<>'object' THEN RAISE EXCEPTION 'guarded_read_request_invalid' USING ERRCODE='22023'; END IF;
 purpose:=p_request->>'purpose';
 IF jsonb_typeof(p_request->'owner') IS DISTINCT FROM 'string' OR p_request->>'owner'<>'sim_driver_measurements'
  OR jsonb_typeof(p_request->'scope') IS DISTINCT FROM 'string' OR p_request->>'scope'<>'online_driver_scope'
  OR jsonb_typeof(p_request->'purpose') IS DISTINCT FROM 'string'
  OR purpose NOT IN ('capability','intake','preflight','status','receipt')
 THEN RAISE EXCEPTION 'guarded_read_request_invalid' USING ERRCODE='22023'; END IF;
 required_keys:=CASE WHEN purpose IN ('capability','intake') THEN ARRAY['owner','scope','purpose']
   ELSE ARRAY['owner','scope','purpose','operationHash','actorHash'] END;
 IF NOT(p_request ?& required_keys) OR (SELECT count(*) FROM jsonb_object_keys(p_request))<>cardinality(required_keys)
 THEN RAISE EXCEPTION 'guarded_read_request_invalid' USING ERRCODE='22023'; END IF;
 IF purpose IN ('preflight','status','receipt') AND
   (jsonb_typeof(p_request->'operationHash') IS DISTINCT FROM 'string' OR (p_request->>'operationHash') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_request->'actorHash') IS DISTINCT FROM 'string' OR (p_request->>'actorHash') !~ '^[0-9a-f]{64}$')
 THEN RAISE EXCEPTION 'guarded_read_request_invalid' USING ERRCODE='22023'; END IF;

 -- Fixed seven-table catalog core. No table content is scanned for fingerprints.
 SELECT jsonb_agg(jsonb_build_object('name',names.name,'exists',c.oid IS NOT NULL,
   'kind',c.relkind::text,'owner',pg_get_userbyid(c.relowner),'rowSecurity',c.relrowsecurity,'forceRowSecurity',c.relforcerowsecurity,
   'columns',coalesce((SELECT jsonb_agg(x.value ORDER BY x.position) FROM (
     SELECT a.attnum AS position,jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
       'notNull',a.attnotnull,'identity',a.attidentity::text,'generated',a.attgenerated::text,
       'default',pg_get_expr(d.adbin,d.adrelid),'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END) AS value
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 256)x),'[]'::jsonb),
   'constraints',coalesce((SELECT jsonb_agg(x.value ORDER BY x.name) FROM (
     SELECT k.conname AS name,jsonb_build_object('name',k.conname,'kind',k.contype::text,'validated',k.convalidated,
       'deferrable',k.condeferrable,'deferred',k.condeferred,'definition',pg_get_constraintdef(k.oid,true)) AS value
     FROM pg_constraint k WHERE k.conrelid=c.oid ORDER BY k.conname LIMIT 128)x),'[]'::jsonb),
   'indexes',coalesce((SELECT jsonb_agg(x.value ORDER BY x.name) FROM (
     SELECT irel.relname AS name,jsonb_build_object('name',irel.relname,'valid',i.indisvalid,'ready',i.indisready,
       'unique',i.indisunique,'primary',i.indisprimary,'definition',pg_get_indexdef(i.indexrelid)) AS value
     FROM pg_index i JOIN pg_class irel ON irel.oid=i.indexrelid WHERE i.indrelid=c.oid ORDER BY irel.relname LIMIT 32)x),'[]'::jsonb),
   'triggers',coalesce((SELECT jsonb_agg(x.value ORDER BY x.name) FROM (
     SELECT t.tgname AS name,jsonb_build_object('name',t.tgname,'enabled',t.tgenabled::text,
       'internal',t.tgisinternal,'definition',pg_get_triggerdef(t.oid,true)) AS value
     FROM pg_trigger t WHERE t.tgrelid=c.oid ORDER BY t.tgname LIMIT 32)x),'[]'::jsonb)
   ) ORDER BY names.name) INTO schema_tables
 FROM unnest(table_names) AS names(name)
 LEFT JOIN pg_namespace n ON n.nspname='public' LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=names.name;
 SELECT jsonb_build_object('trigger',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled::text,'type',t.tgtype,
   'function',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig))
 INTO original_guard FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
 WHERE t.tgrelid=to_regclass('public.driver_measurement_receipts')
  AND t.tgname='driver_account_erasure_receipt_guard' AND NOT t.tgisinternal;
 SELECT NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname=ANY(table_names) AND (
   (SELECT count(*) FROM (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LIMIT 257)x)>256
   OR (SELECT count(*) FROM (SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid LIMIT 129)x)>128
   OR (SELECT count(*) FROM (SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid LIMIT 33)x)>32
   OR (SELECT count(*) FROM (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid LIMIT 33)x)>32)) INTO bounded;
 SELECT EXISTS(SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
   WHERE i.indrelid=to_regclass('public.driver_account_erasure_operations') AND i.indisprimary AND i.indisunique
     AND i.indisvalid AND i.indisready AND i.indnatts=1 AND a.attname='operation_hash') INTO ledger_indexed;
 SELECT coalesce(count(*)=7 AND bool_and(c.relkind='r' AND pg_get_userbyid(c.relowner)='driver_measurements_migrator'
   AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
   AND to_jsonb(ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum))=expected_columns->c.relname),false)
 INTO schema_ready FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(table_names);
 schema_ready:=schema_ready AND bounded AND ledger_indexed
  AND coalesce(original_guard->>'enabled' IN ('O','A'),false) AND coalesce((original_guard->>'type')::integer=23,false)
  AND coalesce((original_guard->>'securityDefiner')::boolean=false,false)
  AND coalesce(position('driver-account-erasure-receipt-guard-v1' IN original_guard->>'function')>0,false)
  AND (SELECT count(*)=2 FROM pg_constraint WHERE contype='f' AND convalidated AND NOT condeferrable AND confdeltype='c'
    AND confrelid=to_regclass('public.driver_measurement_receipts')
    AND conrelid IN (to_regclass('public.driver_measurement_intervals'),to_regclass('public.driver_measurement_eta')));
 schema_core:=jsonb_build_object('version','sim-driver-schema-fingerprint-v1','bounded',bounded,'tables',schema_tables,'originalGuard',original_guard);

 -- Actual ACLs plus effective column rights capture PUBLIC and inherited drift.
 -- Membership/function limits are conservative; overflow is never a ready profile.
 SELECT jsonb_build_object('version','sim-driver-privilege-fingerprint-v1',
   'roles',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',r.rolname,'login',r.rolcanlogin,'superuser',r.rolsuper,
     'createDb',r.rolcreatedb,'createRole',r.rolcreaterole,'replication',r.rolreplication,'bypassRls',r.rolbypassrls,'inherit',r.rolinherit) ORDER BY r.rolname),'[]'::jsonb)
     FROM pg_roles r WHERE r.rolname=ANY(role_names)),
   'memberships',(SELECT coalesce(jsonb_agg(x.value ORDER BY x.member_name,x.role_name),'[]'::jsonb) FROM (
     SELECT member_role.rolname AS member_name,granted_role.rolname AS role_name,
       jsonb_build_object('member',member_role.rolname,'role',granted_role.rolname,'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) AS value
     FROM pg_auth_members m JOIN pg_roles member_role ON member_role.oid=m.member JOIN pg_roles granted_role ON granted_role.oid=m.roleid
     WHERE member_role.rolname=ANY(role_names) OR granted_role.rolname=ANY(role_names)
     ORDER BY member_role.rolname,granted_role.rolname LIMIT 64)x),
   'database',(SELECT jsonb_build_object('owner',pg_get_userbyid(d.datdba),'acl',to_jsonb(d.datacl),
     'runtimeCreate',has_database_privilege('driver_measurements_runtime',d.oid,'CREATE'),
     'runtimeTemp',has_database_privilege('driver_measurements_runtime',d.oid,'TEMP')) FROM pg_database d WHERE d.datname=current_database()),
   'schemas',(SELECT jsonb_agg(jsonb_build_object('name',n.nspname,'owner',pg_get_userbyid(n.nspowner),'acl',to_jsonb(n.nspacl),
     'runtimeUsage',has_schema_privilege('driver_measurements_runtime',n.oid,'USAGE'),'runtimeCreate',has_schema_privilege('driver_measurements_runtime',n.oid,'CREATE')) ORDER BY n.nspname)
     FROM pg_namespace n WHERE n.nspname IN ('public','sim_driver_guard_source')),
   'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'acl',to_jsonb(c.relacl),
     'runtimeSelect',has_table_privilege('driver_measurements_runtime',c.oid,'SELECT'),'runtimeInsert',has_table_privilege('driver_measurements_runtime',c.oid,'INSERT'),
     'runtimeUpdate',has_table_privilege('driver_measurements_runtime',c.oid,'UPDATE'),'runtimeDelete',has_table_privilege('driver_measurements_runtime',c.oid,'DELETE'),
     'runtimeTruncate',has_table_privilege('driver_measurements_runtime',c.oid,'TRUNCATE'),'runtimeReferences',has_table_privilege('driver_measurements_runtime',c.oid,'REFERENCES'),
     'runtimeTrigger',has_table_privilege('driver_measurements_runtime',c.oid,'TRIGGER'),
     'columns',(SELECT coalesce(jsonb_agg(x.value ORDER BY x.position),'[]'::jsonb) FROM (
       SELECT a.attnum AS position,jsonb_build_object('name',a.attname,'acl',to_jsonb(a.attacl),
         'runtimeInsert',has_column_privilege('driver_measurements_runtime',c.oid,a.attnum,'INSERT'),
         'runtimeUpdate',has_column_privilege('driver_measurements_runtime',c.oid,a.attnum,'UPDATE'),
         'runtimeReferences',has_column_privilege('driver_measurements_runtime',c.oid,a.attnum,'REFERENCES')) AS value
       FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 256)x)) ORDER BY c.relname)
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(table_names)),
   'functions',(SELECT coalesce(jsonb_agg(x.value ORDER BY x.name,x.arguments),'[]'::jsonb) FROM (
     SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,
       jsonb_build_object('name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'owner',pg_get_userbyid(p.proowner),
         'securityDefiner',p.prosecdef,'volatility',p.provolatile::text,'config',to_jsonb(p.proconfig),'acl',to_jsonb(p.proacl),
         'definitionDigest',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),
         'runtimeExecute',has_function_privilege('driver_measurements_runtime',p.oid,'EXECUTE')) AS value
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='sim_driver_guard_source'
     ORDER BY p.proname,pg_get_function_identity_arguments(p.oid) LIMIT 32)x)
   ) INTO privilege_core;
 IF (SELECT count(*) FROM (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid
     WHERE r.rolname=ANY(role_names) OR g.rolname=ANY(role_names) LIMIT 65)x)>64
   OR (SELECT count(*) FROM (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='sim_driver_guard_source' LIMIT 33)x)>32
 THEN bounded:=false; END IF;
 SELECT coalesce(schema_ready AND bounded
  AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='driver_measurements_runtime' AND rolcanlogin
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sim_driver_guard_owner' AND NOT rolcanlogin
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  AND (SELECT count(*)=2 FROM pg_roles WHERE rolname IN ('sim_driver_guard_control','sim_driver_guard_exec') AND rolcanlogin
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  AND NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='driver_measurements_runtime')
  AND NOT has_database_privilege('driver_measurements_runtime',current_database(),'CREATE,TEMP')
  AND NOT has_schema_privilege('driver_measurements_runtime','public','CREATE')
  AND NOT has_schema_privilege('driver_measurements_runtime','sim_driver_guard_source','USAGE,CREATE')
  AND (SELECT count(*)=7 AND bool_and(has_table_privilege('driver_measurements_runtime',c.oid,'SELECT')
    AND NOT has_table_privilege('driver_measurements_runtime',c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(table_names))
  AND (SELECT count(*)=3 AND bool_and(has_table_privilege('driver_measurements_runtime',c.oid,'INSERT'))
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      AND c.relname IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta'))
  AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    AND c.relname IN ('driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations')
    AND (has_table_privilege('driver_measurements_runtime',c.oid,'INSERT') OR has_any_column_privilege('driver_measurements_runtime',c.oid,'INSERT')))
  AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    AND c.relname=ANY(table_names) AND has_any_column_privilege('driver_measurements_runtime',c.oid,'REFERENCES'))
  AND has_column_privilege('driver_measurements_runtime','public.driver_measurement_receipts','receipt','UPDATE')
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY(table_names) AND a.attnum>0 AND NOT a.attisdropped
      AND NOT(c.relname='driver_measurement_receipts' AND a.attname='receipt')
      AND has_column_privilege('driver_measurements_runtime',c.oid,a.attnum,'UPDATE'))
  AND has_function_privilege('driver_measurements_runtime','public.driver_account_erasure_receipt_guard()','EXECUTE')
  AND (SELECT count(*)=6 AND bool_and(p.prosecdef AND pg_get_userbyid(p.proowner)='sim_driver_guard_owner'
    AND NOT has_function_privilege('driver_measurements_runtime',p.oid,'EXECUTE'))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='sim_driver_guard_source'
      AND p.proname IN ('register_origin','claim_origin','execute_origin','resolve_or_seal','read_publication_context','read_admission_facts'))
 ,false) INTO profile_matches;
 privilege_core:=privilege_core||jsonb_build_object('bounded',bounded);

 -- The only optional business-row query is PK-indexed and actor+operation exact.
 -- No account/contributor inventory is selected; no origin journal is inspected.
 IF purpose IN ('preflight','status','receipt') AND ledger_indexed THEN
  SELECT * INTO ledger FROM public.driver_account_erasure_operations
   WHERE operation_hash=p_request->>'operationHash' AND actor_hash=p_request->>'actorHash';
  IF FOUND THEN
   IF NOT isfinite(ledger.created_at) OR NOT isfinite(ledger.updated_at) THEN RAISE EXCEPTION 'guarded_read_operation_invalid'; END IF;
   operation_value:=jsonb_build_object('operationHash',ledger.operation_hash::text,'actorHash',ledger.actor_hash::text,'requestHash',ledger.request_hash::text,
    'contributorCount',ledger.contributor_count,'status',ledger.status,
    'createdAtUTC',to_char(ledger.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAtUTC',to_char(ledger.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'deletedBatchCount',ledger.deleted_batch_count,'remainingBatchCount',ledger.remaining_batch_count,
    'databaseZeroVerified',ledger.database_zero_verified,'derivedReportAcknowledged',ledger.derived_report_acknowledged,
    'replayCheckpointHash',ledger.replay_checkpoint_hash::text,'ledgerDigest',encode(sha256(convert_to(to_jsonb(ledger)::text,'UTF8')),'hex'));
  END IF;
 END IF;
 SELECT incarnation INTO store_value FROM sim_driver_guard_source.store_binding WHERE singleton;
 IF to_regclass('public.driver_account_erasure_state') IS NOT NULL THEN
  SELECT * INTO state_row FROM public.driver_account_erasure_state WHERE singleton LIMIT 1;
  IF FOUND THEN
   checkpoint:=state_row.replay_checkpoint_hash::text; replay_ready:=state_row.replay_ready;
   proof_until:=CASE WHEN isfinite(state_row.proof_valid_until) THEN state_row.proof_valid_until ELSE NULL END;
   retention_reviewed:=state_row.retention_reviewed; protection:=state_row.report_protection;
   publication_verified:=state_row.publication_fence_verified;
  END IF;
 END IF;
 observed:=clock_timestamp();
 state_value:=jsonb_build_object('checkpointHash',checkpoint,'replayReady',replay_ready,
  'proofValidUntilUTC',CASE WHEN proof_until IS NULL THEN NULL ELSE to_char(proof_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
  'proofCurrent',coalesce(proof_until>observed,false),'retentionReviewed',retention_reviewed,
  'reportProtection',protection,'publicationFenceVerified',publication_verified);
 RETURN jsonb_build_object('contractVersion','sim-driver-read-facts-v1','request',p_request,
  'observedAtUTC',to_char(observed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'storeIncarnation',store_value,
  'state',state_value,'schema',jsonb_build_object('ready',schema_ready,'fingerprint',encode(sha256(convert_to(schema_core::text,'UTF8')),'hex')),
  'privileges',jsonb_build_object('runtimeProfileMatches',profile_matches,'fingerprint',encode(sha256(convert_to(privilege_core::text,'UTF8')),'hex')),
  'operation',operation_value);
END $facts$;
REVOKE ALL ON FUNCTION sim_driver_guard_source.read_admission_facts(jsonb)
 FROM PUBLIC,driver_measurements_runtime,sim_driver_guard_exec,sim_driver_guard_control;
GRANT EXECUTE ON FUNCTION sim_driver_guard_source.read_admission_facts(jsonb) TO sim_driver_guard_control;
RESET ROLE;
COMMIT;
