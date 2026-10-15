-- SOURCE ONLY: forward constraint hardening for the dedicated Driver database.
-- Apply as the existing migration owner/DBA, after the reviewed 002..006 source.
-- No role, grant, credential, runtime binding, data repair or data deletion.
-- An orphan ETA or an ETA/receipt contributor mismatch aborts the transaction;
-- the migration must never relabel the ETA or delete its unrelated parent.
--
-- The existing (owner,batch_id) ETA FK is atomically REPLACED, not supplemented,
-- so the unchanged 004 reader still sees exactly two validated receipt cascades
-- (intervals + ETA). The new FK is immediate/nondeferrable and binds all three
-- columns to the new nondeferrable receipt UNIQUE constraint. Existing receipt
-- PK, ETA PK/observation uniqueness, receipt guard, ledgers and fences remain.
--
-- Both data tables are locked before the mismatch check and remain locked until
-- COMMIT; other retained tables are protected against concurrent DDL. Each lock
-- wait is bounded to 1.5s and each statement to 15s; a timeout aborts, never adopts.
-- This changes the actual schema fingerprint and requires separate independent
-- policy review/pinning. It is NOT admission, readiness, erasure or activation.
BEGIN;
SET LOCAL lock_timeout='1500ms';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path=pg_catalog;

DO $database$
BEGIN
 IF current_database()<>'sim_driver_measurements' THEN
  RAISE EXCEPTION 'dedicated_driver_database_required';
 END IF;
END $database$;

-- Fixed relation names/order only: no caller-selected relation or dynamic DDL.
LOCK TABLE public.driver_measurement_receipts, public.driver_measurement_eta IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.driver_measurement_intervals, public.driver_measurement_revocations,
 public.driver_account_erasure_state, public.driver_account_erasure_operations,
 public.driver_account_erasure_revocations IN ACCESS SHARE MODE;

DO $preconditions$
DECLARE
 table_names text[]:=ARRAY['driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta',
  'driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations'];
 expected_columns jsonb:='{"driver_measurement_receipts":["owner","batch_id","contributor_hash","request_hash","received_at","expires_at","receipt"],"driver_measurement_intervals":["owner","batch_id","measurement_key","dataset","edge_id","window_start","speed_kph","distance_m","elapsed_seconds"],"driver_measurement_eta":["owner","batch_id","observation_id","contributor_hash","dataset","window_start","predicted_seconds","actual_seconds"],"driver_measurement_revocations":["owner","contributor_hash","expires_at"],"driver_account_erasure_state":["singleton","replay_ready","replay_checkpoint_hash","proof_valid_until","retention_reviewed","report_protection","publication_fence_verified"],"driver_account_erasure_operations":["operation_hash","actor_hash","request_hash","created_at","updated_at","contributor_count","deleted_batch_count","remaining_batch_count","database_zero_verified","derived_report_acknowledged","replay_checkpoint_hash","status"],"driver_account_erasure_revocations":["owner","contributor_hash","revoked_at"]}'::jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sim_driver_guard_owner'
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls)
  OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('sim_driver_guard_control','sim_driver_guard_exec')
    AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls)<>2
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='driver_measurements_runtime'
    AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls)
 THEN RAISE EXCEPTION 'owned_restricted_roles_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname='sim_driver_guard_source' AND r.rolname='sim_driver_guard_owner')
 THEN RAISE EXCEPTION 'owned_source_schema_required'; END IF;
 IF NOT pg_has_role('sim_driver_guard_owner','sim_driver_guard_exec','MEMBER')
 THEN RAISE EXCEPTION 'narrow_executor_metadata_membership_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles member_role ON member_role.oid=m.member
    JOIN pg_roles granted_role ON granted_role.oid=m.roleid
    WHERE (member_role.rolname IN ('driver_measurements_runtime','sim_driver_guard_owner',
      'sim_driver_guard_control','sim_driver_guard_exec')
      OR granted_role.rolname IN ('sim_driver_guard_owner','sim_driver_guard_control','sim_driver_guard_exec'))
      AND NOT(member_role.rolname='sim_driver_guard_owner' AND granted_role.rolname='sim_driver_guard_exec'))
 THEN RAISE EXCEPTION 'source_role_isolation_required'; END IF;
 IF NOT coalesce((SELECT count(*)=7 AND bool_and(c.relkind='r'
     AND pg_get_userbyid(c.relowner)='driver_measurements_migrator'
     AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
     AND to_jsonb(ARRAY(SELECT a.attname::text FROM pg_attribute a
       WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum))=expected_columns->c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY(table_names)),false)
 THEN RAISE EXCEPTION 'unchanged_actual_driver_tables_required'; END IF;
 -- Referenced/referencing key types, nullability and physical column positions
 -- must be the original ones; no renamed/retyped/nullable key is adopted.
 IF (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    AND c.relname IN ('driver_measurement_receipts','driver_measurement_eta')
    AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull
    AND ((a.attname='owner' AND a.attnum=1 AND a.atttypid='text'::regtype AND a.atttypmod=-1)
      OR (a.attname='batch_id' AND a.attnum=2 AND a.atttypid='uuid'::regtype AND a.atttypmod=-1)
      OR (a.attname='contributor_hash' AND a.attnum=CASE c.relname WHEN 'driver_measurement_receipts' THEN 3 ELSE 4 END
        AND a.atttypid='bpchar'::regtype AND a.atttypmod=68)))<>6
 THEN RAISE EXCEPTION 'unchanged_actual_contributor_keys_required'; END IF;
 IF (SELECT count(*) FROM pg_constraint k JOIN pg_index i ON i.indexrelid=k.conindid
    WHERE k.contype='p' AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
      AND k.conkey=ARRAY[1,2]::smallint[] AND i.indisvalid AND i.indisready AND i.indisunique
      AND k.conrelid IN ('public.driver_measurement_receipts'::regclass,'public.driver_measurement_eta'::regclass))<>2
  OR NOT EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_index i ON i.indexrelid=k.conindid
    WHERE k.conrelid='public.driver_measurement_eta'::regclass AND k.contype='u'
      AND k.conkey=ARRAY[1,4,3]::smallint[] AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
      AND i.indisvalid AND i.indisready AND i.indisunique)
 THEN RAISE EXCEPTION 'original_receipt_eta_keys_required'; END IF;
 IF (SELECT count(*) FROM pg_constraint WHERE contype='f'
    AND conrelid IN ('public.driver_measurement_intervals'::regclass,'public.driver_measurement_eta'::regclass))<>2
  OR (SELECT count(*) FROM pg_constraint WHERE contype='f' AND convalidated
    AND NOT condeferrable AND NOT condeferred AND confdeltype='c' AND confupdtype='a' AND confmatchtype='s'
    AND conkey=ARRAY[1,2]::smallint[] AND confkey=ARRAY[1,2]::smallint[]
    AND confrelid='public.driver_measurement_receipts'::regclass
    AND ((conrelid='public.driver_measurement_intervals'::regclass AND conname='driver_measurement_intervals_owner_batch_id_fkey')
      OR (conrelid='public.driver_measurement_eta'::regclass AND conname='driver_measurement_eta_owner_batch_id_fkey')))<>2
 THEN RAISE EXCEPTION 'exact_original_receipt_cascades_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid='public.driver_measurement_receipts'::regclass
      AND t.tgname='driver_account_erasure_receipt_guard' AND NOT t.tgisinternal
      AND t.tgenabled IN ('O','A') AND t.tgtype=23 AND NOT p.prosecdef
      AND position('driver-account-erasure-receipt-guard-v1' IN pg_get_functiondef(p.oid))>0)
 THEN RAISE EXCEPTION 'actual_erasure_guard_required'; END IF;
 IF (SELECT count(*) FROM pg_proc p WHERE p.prosecdef AND pg_get_userbyid(p.proowner)='sim_driver_guard_owner'
    AND p.oid IN (to_regprocedure('sim_driver_guard_source.register_origin(uuid,uuid,uuid,text,text,text,timestamptz)'),
      to_regprocedure('sim_driver_guard_source.claim_origin(uuid,uuid,xid8,integer,timestamptz)'),
      to_regprocedure('sim_driver_guard_source.execute_origin(uuid,jsonb)'),
      to_regprocedure('sim_driver_guard_source.resolve_or_seal(uuid)'),
      to_regprocedure('sim_driver_guard_source.read_publication_context(uuid,jsonb)'),
      to_regprocedure('sim_driver_guard_source.read_admission_facts(jsonb)'),
      to_regprocedure('sim_driver_guard_source.apply_root_checkpoint(jsonb)'),
      to_regprocedure('sim_driver_guard_source.read_inventory_candidates(jsonb)')))<>8
 THEN RAISE EXCEPTION 'guarded_003_through_006_source_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname IN ('driver_receipt_contributor_binding_key','driver_eta_contributor_binding_fkey')
    AND conrelid IN ('public.driver_measurement_receipts'::regclass,'public.driver_measurement_eta'::regclass))
  OR to_regclass('public.driver_receipt_contributor_binding_key') IS NOT NULL
 THEN RAISE EXCEPTION 'existing_eta_contributor_binding_not_adopted'; END IF;
 -- Includes orphans even if a historical FK was disabled without being marked
 -- unvalidated. No details of either contributor or parent are emitted.
 IF EXISTS(SELECT 1 FROM public.driver_measurement_eta e
    LEFT JOIN public.driver_measurement_receipts r ON r.owner=e.owner AND r.batch_id=e.batch_id
    WHERE r.batch_id IS NULL OR e.contributor_hash IS DISTINCT FROM r.contributor_hash)
 THEN RAISE EXCEPTION 'eta_parent_contributor_mismatch' USING ERRCODE='23514'; END IF;
END $preconditions$;

ALTER TABLE public.driver_measurement_receipts
 ADD CONSTRAINT driver_receipt_contributor_binding_key
 UNIQUE(owner,batch_id,contributor_hash) NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.driver_measurement_eta
 ADD CONSTRAINT driver_eta_contributor_binding_fkey
 FOREIGN KEY(owner,batch_id,contributor_hash)
 REFERENCES public.driver_measurement_receipts(owner,batch_id,contributor_hash)
 ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.driver_measurement_eta
 DROP CONSTRAINT driver_measurement_eta_owner_batch_id_fkey;

DO $postconditions$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_index i ON i.indexrelid=k.conindid
    WHERE k.conrelid='public.driver_measurement_receipts'::regclass
      AND k.conname='driver_receipt_contributor_binding_key' AND k.contype='u'
      AND k.conkey=ARRAY[1,2,3]::smallint[] AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
      AND i.indisvalid AND i.indisready AND i.indisunique)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.driver_measurement_eta'::regclass
    AND conname='driver_eta_contributor_binding_fkey' AND contype='f'
    AND conkey=ARRAY[1,2,4]::smallint[] AND confkey=ARRAY[1,2,3]::smallint[]
    AND confrelid='public.driver_measurement_receipts'::regclass
    AND convalidated AND NOT condeferrable AND NOT condeferred
    AND confdeltype='c' AND confupdtype='a' AND confmatchtype='s')
  OR (SELECT count(*) FROM pg_constraint WHERE contype='f' AND convalidated AND NOT condeferrable
    AND confdeltype='c' AND confrelid='public.driver_measurement_receipts'::regclass
    AND conrelid IN ('public.driver_measurement_intervals'::regclass,'public.driver_measurement_eta'::regclass))<>2
 THEN RAISE EXCEPTION 'eta_contributor_binding_postcondition_failed'; END IF;
END $postconditions$;
COMMIT;
