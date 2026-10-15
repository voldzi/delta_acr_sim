-- SOURCE ONLY: bounded checkpoint metadata application by the fixed private
-- Root control channel. This source is not installation, activation, replay
-- verification, Root enrollment or proof of whole-account completion.
-- Frozen schema/002/003/004, origins, fences, ledgers and reports are unchanged.
-- No role, membership, credential, store binding or state row is created.
--
-- Root must independently verify the actual signed/current owner, continuity,
-- restore/replay, retention and publication records BEFORE calling this RPC.
-- The database cannot authenticate their signatures or derive their truth from
-- its own flags. rootRecordRef is strictly typed, echoed and never persisted;
-- the protected Root journal retains its provenance outside this database.
-- SQL confirms only the prebound store, existing singleton and previous-value
-- CAS, applies six metadata columns, and returns the actual updated readback.
-- Three true readiness flags plus protected report mode enable the reviewed
-- state; three false flags plus unverified explicitly quarantine it. Mixed
-- states are rejected. Both modes require a canonical future proof <=30 seconds.
-- Root/client must additionally bound the complete request and uncertain commit
-- handling; the function's one-second lock timeout is not a network deadline.
BEGIN;
DO $preconditions$
BEGIN
 IF current_database()<>'sim_driver_measurements' THEN
  RAISE EXCEPTION 'dedicated_driver_database_required';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sim_driver_guard_owner'
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls)
  OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('sim_driver_guard_control','sim_driver_guard_exec')
    AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls)<>2
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='driver_measurements_runtime'
    AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname='sim_driver_guard_source' AND r.rolname='sim_driver_guard_owner')
 THEN RAISE EXCEPTION 'owned_guard_source_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles member_role ON member_role.oid=m.member
    JOIN pg_roles granted_role ON granted_role.oid=m.roleid
    WHERE (member_role.rolname IN ('driver_measurements_runtime','sim_driver_guard_owner',
      'sim_driver_guard_control','sim_driver_guard_exec')
      OR granted_role.rolname IN ('sim_driver_guard_owner','sim_driver_guard_control','sim_driver_guard_exec'))
      AND NOT(member_role.rolname='sim_driver_guard_owner' AND granted_role.rolname='sim_driver_guard_exec'))
 THEN RAISE EXCEPTION 'source_role_isolation_required'; END IF;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='sim_driver_guard_source' AND p.prosecdef AND pg_get_userbyid(p.proowner)='sim_driver_guard_owner'
    AND p.oid IN (to_regprocedure('sim_driver_guard_source.register_origin(uuid,uuid,uuid,text,text,text,timestamptz)'),
      to_regprocedure('sim_driver_guard_source.claim_origin(uuid,uuid,xid8,integer,timestamptz)'),
      to_regprocedure('sim_driver_guard_source.execute_origin(uuid,jsonb)'),
      to_regprocedure('sim_driver_guard_source.resolve_or_seal(uuid)'),
      to_regprocedure('sim_driver_guard_source.read_publication_context(uuid,jsonb)'),
      to_regprocedure('sim_driver_guard_source.read_admission_facts(jsonb)')))<>6
  OR to_regclass('sim_driver_guard_source.store_binding') IS NULL
 THEN RAISE EXCEPTION 'guarded_003_004_source_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='driver_account_erasure_state' AND c.relkind='r'
      AND pg_get_userbyid(c.relowner)='driver_measurements_migrator'
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
 THEN RAISE EXCEPTION 'unchanged_actual_driver_state_required'; END IF;
 IF has_table_privilege('sim_driver_guard_owner','public.driver_account_erasure_state','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR has_any_column_privilege('sim_driver_guard_owner','public.driver_account_erasure_state','INSERT,REFERENCES')
 THEN RAISE EXCEPTION 'narrow_checkpoint_owner_privileges_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM sim_driver_guard_source.store_binding WHERE singleton AND incarnation IS NOT NULL)
 THEN RAISE EXCEPTION 'prebound_driver_store_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.driver_account_erasure_state WHERE singleton)
 THEN RAISE EXCEPTION 'existing_driver_state_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='sim_driver_guard_source' AND p.proname='apply_root_checkpoint')
 THEN RAISE EXCEPTION 'existing_root_checkpoint_not_adopted'; END IF;
END $preconditions$;

-- DBA-applied, column-scoped addition only. The existing UPDATE(singleton)
-- prerequisite for the frozen 003 FOR SHARE reads is deliberately unchanged.
-- No table-level UPDATE, INSERT or DELETE is granted to any role.
GRANT UPDATE(replay_ready,replay_checkpoint_hash,proof_valid_until,
 retention_reviewed,report_protection,publication_fence_verified)
 ON public.driver_account_erasure_state TO sim_driver_guard_owner;

SET ROLE sim_driver_guard_owner;
CREATE FUNCTION sim_driver_guard_source.apply_root_checkpoint(p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog SET TimeZone='UTC' SET row_security=off
SET lock_timeout='1000ms' AS $checkpoint$
DECLARE
 keys text[]:=ARRAY['contractVersion','owner','scope','storeIncarnation','expectedPreviousCheckpointHash',
  'checkpointHash','proofValidUntilUTC','replayReady','retentionReviewed','reportProtection',
  'publicationFenceVerified','rootRecordRef'];
 previous_checkpoint text; requested_checkpoint text; requested_store uuid; bound_store uuid;
 proof_until timestamptz; observed timestamptz; applied_at timestamptz;
 ready boolean; reviewed boolean; publication_verified boolean; protection text;
 gate public.driver_account_erasure_state%ROWTYPE;
BEGIN
 IF current_database()<>'sim_driver_measurements' OR session_user<>'sim_driver_guard_control'
 THEN RAISE EXCEPTION 'fixed_control_channel_required'; END IF;
 IF current_setting('transaction_read_only')<>'off'
 THEN RAISE EXCEPTION 'checkpoint_write_transaction_required'; END IF;
 IF p_body IS NULL OR jsonb_typeof(p_body)<>'object' OR octet_length(p_body::text)>4096
 THEN RAISE EXCEPTION 'guarded_checkpoint_request_invalid' USING ERRCODE='22023'; END IF;
 IF NOT(p_body ?& keys) OR (SELECT count(*) FROM jsonb_object_keys(p_body))<>cardinality(keys)
 THEN RAISE EXCEPTION 'guarded_checkpoint_request_invalid' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_body->'contractVersion') IS DISTINCT FROM 'string'
  OR p_body->>'contractVersion'<>'sim-driver-root-checkpoint-v1'
  OR jsonb_typeof(p_body->'owner') IS DISTINCT FROM 'string' OR p_body->>'owner'<>'sim_driver_measurements'
  OR jsonb_typeof(p_body->'scope') IS DISTINCT FROM 'string' OR p_body->>'scope'<>'online_driver_scope'
  OR jsonb_typeof(p_body->'storeIncarnation') IS DISTINCT FROM 'string'
  OR (p_body->>'storeIncarnation') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR jsonb_typeof(p_body->'checkpointHash') IS DISTINCT FROM 'string'
  OR (p_body->>'checkpointHash') !~ '^[0-9a-f]{64}$'
  OR jsonb_typeof(p_body->'expectedPreviousCheckpointHash') NOT IN ('string','null')
  OR (jsonb_typeof(p_body->'expectedPreviousCheckpointHash')='string'
    AND (p_body->>'expectedPreviousCheckpointHash') !~ '^[0-9a-f]{64}$')
  OR jsonb_typeof(p_body->'proofValidUntilUTC') IS DISTINCT FROM 'string'
  OR (p_body->>'proofValidUntilUTC') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  OR jsonb_typeof(p_body->'replayReady') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(p_body->'retentionReviewed') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(p_body->'publicationFenceVerified') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(p_body->'reportProtection') IS DISTINCT FROM 'string'
  OR p_body->>'reportProtection' NOT IN ('unverified','no_report','enforced_single_writer','shared_generation_fence')
  OR jsonb_typeof(p_body->'rootRecordRef') IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'guarded_checkpoint_request_invalid' USING ERRCODE='22023'; END IF;
 IF NOT((p_body->'rootRecordRef') ?& ARRAY['recordId','digest'])
  OR (SELECT count(*) FROM jsonb_object_keys(p_body->'rootRecordRef'))<>2
  OR jsonb_typeof(p_body->'rootRecordRef'->'recordId') IS DISTINCT FROM 'string'
  OR (p_body->'rootRecordRef'->>'recordId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR jsonb_typeof(p_body->'rootRecordRef'->'digest') IS DISTINCT FROM 'string'
  OR (p_body->'rootRecordRef'->>'digest') !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'guarded_checkpoint_request_invalid' USING ERRCODE='22023'; END IF;
 BEGIN
  proof_until:=(p_body->>'proofValidUntilUTC')::timestamptz;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RAISE EXCEPTION 'guarded_checkpoint_request_invalid' USING ERRCODE='22023';
 END;
 IF NOT isfinite(proof_until)
  OR to_char(proof_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>p_body->>'proofValidUntilUTC'
 THEN RAISE EXCEPTION 'guarded_checkpoint_request_invalid' USING ERRCODE='22023'; END IF;
 requested_store:=(p_body->>'storeIncarnation')::uuid;
 requested_checkpoint:=p_body->>'checkpointHash';
 previous_checkpoint:=p_body->>'expectedPreviousCheckpointHash';
 ready:=(p_body->>'replayReady')::boolean; reviewed:=(p_body->>'retentionReviewed')::boolean;
 publication_verified:=(p_body->>'publicationFenceVerified')::boolean; protection:=p_body->>'reportProtection';
 IF NOT((ready AND reviewed AND publication_verified AND protection IN ('no_report','enforced_single_writer','shared_generation_fence'))
    OR (NOT ready AND NOT reviewed AND NOT publication_verified AND protection='unverified'))
 THEN RAISE EXCEPTION 'guarded_checkpoint_mode_invalid' USING ERRCODE='22023'; END IF;

 -- The store cannot change while the singleton CAS is being applied. No store
 -- binding, ledger, origin, contributor fence or derived report is modified.
 SELECT incarnation INTO bound_store FROM sim_driver_guard_source.store_binding WHERE singleton FOR SHARE;
 IF NOT FOUND OR bound_store IS DISTINCT FROM requested_store
 THEN RAISE EXCEPTION 'guarded_checkpoint_store_mismatch'; END IF;
 SELECT * INTO gate FROM public.driver_account_erasure_state WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'guarded_checkpoint_state_missing'; END IF;
 IF gate.replay_checkpoint_hash::text IS DISTINCT FROM previous_checkpoint
 THEN RAISE EXCEPTION 'guarded_checkpoint_previous_conflict' USING ERRCODE='23505'; END IF;
 observed:=clock_timestamp();
 IF proof_until<=observed OR proof_until>observed+interval '30 seconds'
 THEN RAISE EXCEPTION 'guarded_checkpoint_proof_not_current'; END IF;
 UPDATE public.driver_account_erasure_state
  SET replay_ready=ready,replay_checkpoint_hash=requested_checkpoint,proof_valid_until=proof_until,
      retention_reviewed=reviewed,report_protection=protection,publication_fence_verified=publication_verified
  WHERE singleton AND replay_checkpoint_hash IS NOT DISTINCT FROM previous_checkpoint
  RETURNING * INTO gate;
 IF NOT FOUND THEN RAISE EXCEPTION 'guarded_checkpoint_previous_conflict' USING ERRCODE='23505'; END IF;
 applied_at:=clock_timestamp();
 IF proof_until<=applied_at THEN RAISE EXCEPTION 'guarded_checkpoint_proof_not_current'; END IF;
 RETURN jsonb_build_object('contractVersion','sim-driver-root-checkpoint-result-v1',
  'storeIncarnation',bound_store,'rootRecordRef',p_body->'rootRecordRef',
  'appliedAtUTC',to_char(applied_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'state',jsonb_build_object('checkpointHash',gate.replay_checkpoint_hash::text,'replayReady',gate.replay_ready,
    'proofValidUntilUTC',to_char(gate.proof_valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'proofCurrent',gate.proof_valid_until>applied_at,'retentionReviewed',gate.retention_reviewed,
    'reportProtection',gate.report_protection,'publicationFenceVerified',gate.publication_fence_verified));
END $checkpoint$;
REVOKE ALL ON FUNCTION sim_driver_guard_source.apply_root_checkpoint(jsonb)
 FROM PUBLIC,driver_measurements_runtime,sim_driver_guard_exec,sim_driver_guard_control;
GRANT EXECUTE ON FUNCTION sim_driver_guard_source.apply_root_checkpoint(jsonb) TO sim_driver_guard_control;
RESET ROLE;
COMMIT;
