-- SOURCE ONLY: fixed private Root-control checkpoint metadata publisher.
-- Not installation, activation, enrollment, accepted replay, financial
-- reconciliation, signing authority or whole-account completion.
-- Existing 001/002/003/004 sources, billing/usage/keys/costs/ledger/fences/RLS
-- and views stay unchanged. No role, membership, credential, singleton or store
-- binding is created. The checkpoint remains owned by ai_router_migrator.
--
-- Root independently verifies the actual signed/current owner, continuity,
-- replay and cost-policy records BEFORE this call. Flags and a typed reference
-- do not prove those facts. SQL cannot verify a Root signature. rootRecordRef
-- and the <=30-second proof deadline are transient and echoed, never persisted;
-- the external protected Root journal owns provenance and uncertain delivery.
-- There is deliberately no new TTL column or automatic checkpoint adoption.
-- After a known apply, Root obtains fresh read-only 004 facts/digests and
-- independently validates them before issuing any short-lived admission.
-- A changed function/column ACL changes the actual privilege fingerprint and
-- requires separately reviewed Root policy; old pins must fail closed.
--
-- Active: both flags true + aggregate-costs-current-month-v1.
-- Quarantine: both flags false + pending_requires_review. Mixed states reject.
-- Generations are canonical decimal strings, actual CAS plus exactly one;
-- they never pass through JSON/JavaScript floating-point numbers.
BEGIN;
DO $preconditions$
BEGIN
 IF pg_catalog.current_database()<>'sim_ai_router'
 THEN RAISE EXCEPTION 'dedicated_ai_router_database_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='sim_ai_guard_owner' AND NOT rolcanlogin
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='sim_ai_guard_control' AND rolcanlogin
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='ai_router_runtime' AND rolcanlogin
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname='sim_ai_guard_source' AND r.rolname='sim_ai_guard_owner')
 THEN RAISE EXCEPTION 'fixed_owned_ai_guard_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member
    JOIN pg_catalog.pg_roles g ON g.oid=m.roleid
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
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid=pg_catalog.to_regprocedure('sim_ai_guard_source.read_checkpoint_facts(jsonb)')
      AND p.prosecdef AND p.provolatile='s' AND pg_catalog.pg_get_userbyid(p.proowner)='sim_ai_guard_owner')
  OR pg_catalog.to_regclass('sim_ai_guard_source.store_binding') IS NULL
 THEN RAISE EXCEPTION 'ai_guarded_004_source_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='ai_router_erasure_checkpoint' AND c.relkind='r'
      AND pg_catalog.pg_get_userbyid(c.relowner)='ai_router_migrator' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
 THEN RAISE EXCEPTION 'unchanged_ai_checkpoint_table_required'; END IF;
 IF pg_catalog.has_table_privilege('sim_ai_guard_owner','public.ai_router_erasure_checkpoint','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR pg_catalog.has_any_column_privilege('sim_ai_guard_owner','public.ai_router_erasure_checkpoint','INSERT,REFERENCES')
  OR pg_catalog.has_table_privilege('sim_ai_guard_control','public.ai_router_erasure_checkpoint','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR pg_catalog.has_any_column_privilege('sim_ai_guard_control','public.ai_router_erasure_checkpoint','INSERT,UPDATE,REFERENCES')
  OR pg_catalog.has_table_privilege('ai_router_runtime','public.ai_router_erasure_checkpoint','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR pg_catalog.has_any_column_privilege('ai_router_runtime','public.ai_router_erasure_checkpoint','INSERT,UPDATE,REFERENCES')
 THEN RAISE EXCEPTION 'narrow_ai_checkpoint_privileges_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM sim_ai_guard_source.store_binding WHERE singleton AND incarnation IS NOT NULL)
 THEN RAISE EXCEPTION 'prebound_ai_store_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ai_router_erasure_checkpoint WHERE id=1 AND schema_version=1)
 THEN RAISE EXCEPTION 'existing_ai_checkpoint_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='sim_ai_guard_source' AND p.proname='apply_root_checkpoint')
 THEN RAISE EXCEPTION 'existing_ai_checkpoint_publisher_not_adopted'; END IF;
END $preconditions$;

-- DBA-applied column grant only; no INSERT/DELETE or table-wide UPDATE.
-- 004's existing column SELECT is sufficient for the five-field readback.
GRANT UPDATE(identity_reviewed,replay_ready,cost_policy,checkpoint_id,checkpoint_generation,updated_at)
 ON public.ai_router_erasure_checkpoint TO sim_ai_guard_owner;

SET ROLE sim_ai_guard_owner;
CREATE FUNCTION sim_ai_guard_source.apply_root_checkpoint(p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public SET TimeZone='UTC' SET row_security=off
SET lock_timeout='1000ms' AS $checkpoint$
DECLARE
 keys text[]:=ARRAY['contractVersion','owner','scope','storeIncarnation','expectedCheckpointId','expectedGeneration',
  'checkpointId','generation','proofValidUntilUTC','rootRecordRef','identityReviewed','replayReady','costPolicy'];
 requested_store uuid; bound_store uuid; expected_id uuid; requested_id uuid;
 expected_generation bigint; requested_generation bigint; proof_until timestamptz; observed timestamptz; applied_at timestamptz;
 reviewed boolean; ready boolean; policy text; cp record;
BEGIN
 IF pg_catalog.current_database()<>'sim_ai_router' OR session_user<>'sim_ai_guard_control'
 THEN RAISE EXCEPTION 'fixed_ai_control_channel_required'; END IF;
 IF pg_catalog.current_setting('transaction_read_only')<>'off'
 THEN RAISE EXCEPTION 'ai_checkpoint_write_transaction_required'; END IF;
 IF p_body IS NULL OR pg_catalog.jsonb_typeof(p_body)<>'object' OR pg_catalog.octet_length(p_body::text)>4096
 THEN RAISE EXCEPTION 'ai_root_checkpoint_request_invalid' USING ERRCODE='22023'; END IF;
 IF NOT(p_body ?& keys) OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_body))<>pg_catalog.cardinality(keys)
 THEN RAISE EXCEPTION 'ai_root_checkpoint_request_invalid' USING ERRCODE='22023'; END IF;
 IF pg_catalog.jsonb_typeof(p_body->'contractVersion') IS DISTINCT FROM 'string'
  OR p_body->>'contractVersion'<>'sim-ai-root-checkpoint-v1'
  OR pg_catalog.jsonb_typeof(p_body->'owner') IS DISTINCT FROM 'string' OR p_body->>'owner'<>'sim_ai_router'
  OR pg_catalog.jsonb_typeof(p_body->'scope') IS DISTINCT FROM 'string' OR p_body->>'scope'<>'cop_router_primary_database'
  OR pg_catalog.jsonb_typeof(p_body->'storeIncarnation') IS DISTINCT FROM 'string'
  OR p_body->>'storeIncarnation' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR pg_catalog.jsonb_typeof(p_body->'expectedCheckpointId') IS DISTINCT FROM 'string'
  OR p_body->>'expectedCheckpointId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR pg_catalog.jsonb_typeof(p_body->'checkpointId') IS DISTINCT FROM 'string'
  OR p_body->>'checkpointId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR pg_catalog.jsonb_typeof(p_body->'expectedGeneration') IS DISTINCT FROM 'string'
  OR p_body->>'expectedGeneration' !~ '^(0|[1-9][0-9]{0,18})$'
  OR pg_catalog.jsonb_typeof(p_body->'generation') IS DISTINCT FROM 'string'
  OR p_body->>'generation' !~ '^(0|[1-9][0-9]{0,18})$'
  OR pg_catalog.jsonb_typeof(p_body->'proofValidUntilUTC') IS DISTINCT FROM 'string'
  OR p_body->>'proofValidUntilUTC' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  OR pg_catalog.jsonb_typeof(p_body->'rootRecordRef') IS DISTINCT FROM 'object'
  OR pg_catalog.jsonb_typeof(p_body->'identityReviewed') IS DISTINCT FROM 'boolean'
  OR pg_catalog.jsonb_typeof(p_body->'replayReady') IS DISTINCT FROM 'boolean'
  OR pg_catalog.jsonb_typeof(p_body->'costPolicy') IS DISTINCT FROM 'string'
  OR p_body->>'costPolicy' NOT IN ('pending_requires_review','aggregate-costs-current-month-v1')
 THEN RAISE EXCEPTION 'ai_root_checkpoint_request_invalid' USING ERRCODE='22023'; END IF;
 IF NOT((p_body->'rootRecordRef') ?& ARRAY['recordId','digest'])
  OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_body->'rootRecordRef'))<>2
  OR pg_catalog.jsonb_typeof(p_body->'rootRecordRef'->'recordId') IS DISTINCT FROM 'string'
  OR p_body->'rootRecordRef'->>'recordId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR pg_catalog.jsonb_typeof(p_body->'rootRecordRef'->'digest') IS DISTINCT FROM 'string'
  OR p_body->'rootRecordRef'->>'digest' !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'ai_root_checkpoint_request_invalid' USING ERRCODE='22023'; END IF;
 IF (p_body->>'expectedGeneration')::numeric>=9223372036854775807
  OR (p_body->>'generation')::numeric>9223372036854775807
  OR (p_body->>'generation')::numeric<>(p_body->>'expectedGeneration')::numeric+1
 THEN RAISE EXCEPTION 'ai_root_checkpoint_generation_invalid' USING ERRCODE='22023'; END IF;
 expected_generation:=(p_body->>'expectedGeneration')::bigint; requested_generation:=(p_body->>'generation')::bigint;
 requested_store:=(p_body->>'storeIncarnation')::uuid; expected_id:=(p_body->>'expectedCheckpointId')::uuid;
 requested_id:=(p_body->>'checkpointId')::uuid;
 BEGIN
  proof_until:=(p_body->>'proofValidUntilUTC')::timestamptz;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RAISE EXCEPTION 'ai_root_checkpoint_request_invalid' USING ERRCODE='22023';
 END;
 IF NOT pg_catalog.isfinite(proof_until)
  OR pg_catalog.to_char(proof_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>p_body->>'proofValidUntilUTC'
 THEN RAISE EXCEPTION 'ai_root_checkpoint_request_invalid' USING ERRCODE='22023'; END IF;
 reviewed:=(p_body->>'identityReviewed')::boolean; ready:=(p_body->>'replayReady')::boolean; policy:=p_body->>'costPolicy';
 IF NOT((reviewed AND ready AND policy='aggregate-costs-current-month-v1')
    OR (NOT reviewed AND NOT ready AND policy='pending_requires_review'))
 THEN RAISE EXCEPTION 'ai_root_checkpoint_mode_invalid' USING ERRCODE='22023'; END IF;

 SELECT incarnation INTO bound_store FROM sim_ai_guard_source.store_binding WHERE singleton FOR SHARE;
 IF NOT FOUND OR bound_store IS DISTINCT FROM requested_store
 THEN RAISE EXCEPTION 'ai_root_checkpoint_store_mismatch'; END IF;
 SELECT checkpoint_id,checkpoint_generation,identity_reviewed,replay_ready,cost_policy
 INTO cp FROM public.ai_router_erasure_checkpoint WHERE id=1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ai_root_checkpoint_missing'; END IF;
 IF cp.checkpoint_id IS DISTINCT FROM expected_id OR cp.checkpoint_generation IS DISTINCT FROM expected_generation
 THEN RAISE EXCEPTION 'ai_root_checkpoint_previous_conflict' USING ERRCODE='23505'; END IF;
 observed:=pg_catalog.clock_timestamp();
 IF proof_until<=observed OR proof_until>observed+interval '30 seconds'
 THEN RAISE EXCEPTION 'ai_root_checkpoint_proof_not_current'; END IF;
 -- The actual next generation is derived under the row lock. The earlier
 -- numeric check prevents bigint overflow and rejects any skipped generation.
 IF cp.checkpoint_generation>=9223372036854775807 OR requested_generation<>cp.checkpoint_generation+1
 THEN RAISE EXCEPTION 'ai_root_checkpoint_generation_invalid' USING ERRCODE='22023'; END IF;
 applied_at:=pg_catalog.clock_timestamp();
 UPDATE public.ai_router_erasure_checkpoint
  SET identity_reviewed=reviewed,replay_ready=ready,cost_policy=policy,
      checkpoint_id=requested_id,checkpoint_generation=requested_generation,updated_at=applied_at
  WHERE id=1 AND checkpoint_id=expected_id AND checkpoint_generation=expected_generation
  RETURNING checkpoint_id,checkpoint_generation,identity_reviewed,replay_ready,cost_policy INTO cp;
 IF NOT FOUND THEN RAISE EXCEPTION 'ai_root_checkpoint_previous_conflict' USING ERRCODE='23505'; END IF;
 IF proof_until<=pg_catalog.clock_timestamp()
 THEN RAISE EXCEPTION 'ai_root_checkpoint_proof_not_current'; END IF;
 RETURN pg_catalog.jsonb_build_object('contractVersion','sim-ai-root-checkpoint-result-v1',
  'storeIncarnation',bound_store,'rootRecordRef',p_body->'rootRecordRef',
  'appliedAtUTC',pg_catalog.to_char(applied_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'proofValidUntilUTC',p_body->>'proofValidUntilUTC',
  'checkpoint',pg_catalog.jsonb_build_object('checkpointId',cp.checkpoint_id,'generation',cp.checkpoint_generation::text,
    'identityReviewed',cp.identity_reviewed,'replayReady',cp.replay_ready,'costPolicy',cp.cost_policy));
END $checkpoint$;
REVOKE ALL ON FUNCTION sim_ai_guard_source.apply_root_checkpoint(jsonb)
 FROM PUBLIC,ai_router_runtime,sim_ai_guard_control;
GRANT EXECUTE ON FUNCTION sim_ai_guard_source.apply_root_checkpoint(jsonb) TO sim_ai_guard_control;
RESET ROLE;
COMMIT;
