-- SOURCE ONLY: bounded candidate-membership facts for protected Root control.
-- This is not account ownership, candidate derivation, a complete daily/key
-- inventory, Root authority, readiness, publication acknowledgement or erasure.
-- No contributor_day, account/day join, data backfill, role, store binding or
-- default adoption is created. Root must independently authorize/derive the
-- supplied candidates and bind the returned actual store to its current owner.
--
-- candidateCount is the number of input candidates, not the number matched.
-- All stored COP rows count, including zero-accepted/expired-but-not-deleted
-- receipts and temporary revocations. ETA may have a different contributor hash
-- from its parent receipt; both actual columns are therefore inspected.
-- Intervals are covered by the unchanged validated receipt FK/cascade.
--
-- Privilege delta: SELECT(owner,contributor_hash) on the actual ETA table for
-- the existing NOLOGIN guard owner, plus EXECUTE of this function for the fixed
-- control only. These change the independently reviewed privilege fingerprint.
-- Do not automatically adopt the new live fingerprint as trusted policy.
BEGIN;
DO $preconditions$
BEGIN
 IF current_database()<>'sim_driver_measurements'
 THEN RAISE EXCEPTION 'dedicated_driver_database_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sim_driver_guard_owner'
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sim_driver_guard_control'
    AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname='sim_driver_guard_source' AND r.rolname='sim_driver_guard_owner')
 THEN RAISE EXCEPTION 'owned_guard_source_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles member_role ON member_role.oid=m.member
    JOIN pg_roles granted_role ON granted_role.oid=m.roleid
    WHERE (member_role.rolname IN ('driver_measurements_runtime','sim_driver_guard_owner','sim_driver_guard_control','sim_driver_guard_exec')
      OR granted_role.rolname IN ('sim_driver_guard_owner','sim_driver_guard_control','sim_driver_guard_exec'))
      AND NOT(member_role.rolname='sim_driver_guard_owner' AND granted_role.rolname='sim_driver_guard_exec'))
 THEN RAISE EXCEPTION 'source_role_isolation_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='sim_driver_guard_source' AND c.relname='store_binding' AND c.relkind='r'
      AND pg_get_userbyid(c.relowner)='sim_driver_guard_owner' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
  OR to_regprocedure('sim_driver_guard_source.read_admission_facts(jsonb)') IS NULL
 THEN RAISE EXCEPTION 'guarded_source_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM sim_driver_guard_source.store_binding WHERE singleton AND incarnation IS NOT NULL)
 THEN RAISE EXCEPTION 'prebound_driver_store_required'; END IF;
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND pg_get_userbyid(c.relowner)='driver_measurements_migrator'
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relname IN ('driver_measurement_receipts','driver_measurement_eta','driver_measurement_revocations','driver_account_erasure_revocations'))<>4
  OR (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('driver_measurement_receipts','driver_measurement_eta','driver_measurement_revocations','driver_account_erasure_revocations')
      AND a.attnum>0 AND NOT a.attisdropped
      AND ((a.attname='owner' AND a.atttypid='text'::regtype AND a.attnotnull)
        OR (a.attname='contributor_hash' AND a.atttypid='bpchar'::regtype AND a.atttypmod=68 AND a.attnotnull)))<>8
 THEN RAISE EXCEPTION 'unchanged_actual_inventory_columns_required'; END IF;
 IF (SELECT count(*) FROM pg_constraint WHERE contype='f' AND convalidated AND NOT condeferrable AND confdeltype='c'
    AND confrelid='public.driver_measurement_receipts'::regclass
    AND conrelid IN ('public.driver_measurement_intervals'::regclass,'public.driver_measurement_eta'::regclass))<>2
 THEN RAISE EXCEPTION 'actual_receipt_cascades_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='sim_driver_guard_source' AND p.proname='read_inventory_candidates')
 THEN RAISE EXCEPTION 'existing_inventory_candidates_not_adopted'; END IF;
END $preconditions$;

-- Other three source tables already have the necessary SELECT rights for 003;
-- do not widen their grants or grant any direct table access to control/runtime.
GRANT SELECT(owner,contributor_hash) ON public.driver_measurement_eta TO sim_driver_guard_owner;
SET ROLE sim_driver_guard_owner;
CREATE FUNCTION sim_driver_guard_source.read_inventory_candidates(p_hashes jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog SET TimeZone='UTC' SET row_security=off AS $inventory$
DECLARE candidate_count integer; unique_count integer; candidates char(64)[];
 matched text[]; store_value uuid; observed timestamptz;
BEGIN
 IF current_database()<>'sim_driver_measurements' OR session_user<>'sim_driver_guard_control'
 THEN RAISE EXCEPTION 'fixed_control_channel_required'; END IF;
 IF current_setting('transaction_read_only')<>'on'
 THEN RAISE EXCEPTION 'read_only_transaction_required'; END IF;
 -- 4096 canonical JSONB strings of exactly 64 ASCII hex characters occupy at
 -- most 278528 bytes, including quotes, comma-space separators and brackets.
 IF p_hashes IS NULL OR jsonb_typeof(p_hashes) IS DISTINCT FROM 'array'
   OR octet_length(p_hashes::text)>278528
 THEN RAISE EXCEPTION 'guarded_inventory_candidates_invalid' USING ERRCODE='22023'; END IF;
 candidate_count:=jsonb_array_length(p_hashes);
 IF candidate_count NOT BETWEEN 1 AND 4096 OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_hashes) AS item(value)
    WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'string' OR (item.value#>>'{}') !~ '^[0-9a-f]{64}$')
 THEN RAISE EXCEPTION 'guarded_inventory_candidates_invalid' USING ERRCODE='22023'; END IF;
 SELECT count(DISTINCT item.value#>>'{}') INTO unique_count FROM jsonb_array_elements(p_hashes) AS item(value);
 IF unique_count<>candidate_count
 THEN RAISE EXCEPTION 'guarded_inventory_candidates_invalid' USING ERRCODE='22023'; END IF;
 SELECT array_agg((item.value#>>'{}')::char(64) ORDER BY (item.value#>>'{}') COLLATE "C")
 INTO candidates FROM jsonb_array_elements(p_hashes) AS item(value);
 SELECT incarnation INTO store_value FROM sim_driver_guard_source.store_binding WHERE singleton;
 IF store_value IS NULL THEN RAISE EXCEPTION 'prebound_driver_store_required'; END IF;

 -- Cast validated INPUTS, never the indexed source column. Each EXISTS probes
 -- an existing (owner,contributor_hash) index prefix; no collection is returned.
 SELECT coalesce(array_agg(candidate.hash::text ORDER BY candidate.hash::text COLLATE "C"),ARRAY[]::text[])
 INTO matched FROM unnest(candidates) AS candidate(hash)
 WHERE EXISTS(SELECT 1 FROM public.driver_measurement_receipts r WHERE r.owner='cop' AND r.contributor_hash=candidate.hash)
    OR EXISTS(SELECT 1 FROM public.driver_measurement_eta e WHERE e.owner='cop' AND e.contributor_hash=candidate.hash)
    OR EXISTS(SELECT 1 FROM public.driver_measurement_revocations t WHERE t.owner='cop' AND t.contributor_hash=candidate.hash)
    OR EXISTS(SELECT 1 FROM public.driver_account_erasure_revocations p WHERE p.owner='cop' AND p.contributor_hash=candidate.hash);
 observed:=clock_timestamp();
 RETURN jsonb_build_object('contractVersion','sim-driver-inventory-candidates-v1',
  'observedAtUTC',to_char(observed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'storeIncarnation',store_value,'candidateCount',candidate_count,'matchedHashes',matched);
END $inventory$;
REVOKE ALL ON FUNCTION sim_driver_guard_source.read_inventory_candidates(jsonb)
 FROM PUBLIC,driver_measurements_runtime,sim_driver_guard_exec,sim_driver_guard_control;
GRANT EXECUTE ON FUNCTION sim_driver_guard_source.read_inventory_candidates(jsonb) TO sim_driver_guard_control;
RESET ROLE;
COMMIT;
