-- SOURCE-ONLY mechanical candidate for an OWNED ephemeral test database.
-- NOT a migration, runtime integration, production permission or Root authority.
-- Input: unchanged deploy/driver-measurements/schema.sql + 002_account_erasure.sql.
-- Adapted only from whole-COP expiry in COP revision
-- 9f5a1ab54a4253fd0dafc38637c5f8c6ec366807 / candidate.sql SHA-256
-- 40a486bc72046291ad2287a489d3688a1f2d2bbbb53f4d7202c6192de91af8cf.
-- NO contributor-revocation selector, identity hashes, account/GPS origin fields
-- or ledger SQL. Body/schema digests remain opaque operation metadata only.
-- The owned TEST bootstrap, not this file, supplies these restricted roles/schema:
-- sim_driver_expiry_owner NOLOGIN; sim_driver_expiry_control/exec LOGIN;
-- driver_measurements_migrator NOLOGIN owns the unchanged application tables.
-- Bootstrap narrowly grants sim_driver_expiry_exec TO sim_driver_expiry_owner so
-- the function owner can inspect this executor role's pg_stat_activity metadata.
-- It separately denies the ordinary runtime raw DELETE/journal/privileged roles.
-- No role creation, table-owner replacement or production runtime-grant change.
BEGIN;
DO $preconditions$
BEGIN
 IF current_database()<>'sim_driver_measurements' THEN
  RAISE EXCEPTION 'dedicated_driver_database_required';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sim_driver_expiry_owner'
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sim_driver_expiry_control'
    AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sim_driver_expiry_exec'
    AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls)
 THEN RAISE EXCEPTION 'owned_restricted_roles_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname='sim_driver_expiry_source' AND r.rolname='sim_driver_expiry_owner')
 THEN RAISE EXCEPTION 'owned_source_schema_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='sim_driver_expiry_source')
  OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='sim_driver_expiry_source')
 THEN RAISE EXCEPTION 'existing_source_not_adopted'; END IF;
 IF NOT pg_has_role('sim_driver_expiry_owner','sim_driver_expiry_exec','MEMBER')
 THEN RAISE EXCEPTION 'narrow_executor_metadata_membership_required'; END IF;
 IF pg_has_role('sim_driver_expiry_control','sim_driver_expiry_owner','MEMBER')
  OR pg_has_role('sim_driver_expiry_exec','sim_driver_expiry_owner','MEMBER')
  OR pg_has_role('driver_measurements_runtime','sim_driver_expiry_owner','MEMBER')
  OR pg_has_role('driver_measurements_runtime','sim_driver_expiry_control','MEMBER')
  OR pg_has_role('driver_measurements_runtime','sim_driver_expiry_exec','MEMBER')
 THEN RAISE EXCEPTION 'source_role_isolation_required'; END IF;
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND r.rolname='driver_measurements_migrator'
     AND c.relkind='r' AND c.relname IN ('driver_measurement_receipts','driver_measurement_intervals',
       'driver_measurement_eta','driver_measurement_revocations','driver_account_erasure_state',
       'driver_account_erasure_operations','driver_account_erasure_revocations'))<>7
 THEN RAISE EXCEPTION 'unchanged_actual_driver_tables_required'; END IF;
 IF (SELECT count(*) FROM pg_constraint WHERE contype='f' AND convalidated
    AND NOT condeferrable AND confdeltype='c'
    AND confrelid='public.driver_measurement_receipts'::regclass
    AND conrelid IN ('public.driver_measurement_intervals'::regclass,'public.driver_measurement_eta'::regclass))<>2
 THEN RAISE EXCEPTION 'actual_receipt_cascades_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid='public.driver_measurement_receipts'::regclass
      AND t.tgname='driver_account_erasure_receipt_guard' AND NOT t.tgisinternal
      AND t.tgenabled IN ('O','A') AND t.tgtype=23 AND NOT p.prosecdef
      AND position('driver-account-erasure-receipt-guard-v1' IN pg_get_functiondef(p.oid))>0)
 THEN RAISE EXCEPTION 'actual_erasure_guard_required'; END IF;
END $preconditions$;

-- Only the two existing expiration parents. Actual FK cascades retain their
-- original ownership/definitions; no ledger, permanent fence or state privilege.
GRANT SELECT,DELETE ON public.driver_measurement_receipts,public.driver_measurement_revocations
 TO sim_driver_expiry_owner;
SET ROLE sim_driver_expiry_owner;
CREATE TABLE sim_driver_expiry_source.store_binding (
 singleton boolean PRIMARY KEY CHECK(singleton), incarnation uuid NOT NULL UNIQUE
);
-- Intentionally NO default incarnation INSERT: the test admin must prebind it.
CREATE TABLE sim_driver_expiry_source.origins (
 operation_id uuid PRIMARY KEY, store_incarnation uuid NOT NULL,
 permit_id uuid NOT NULL, body_digest text NOT NULL CHECK(body_digest ~ '^[0-9a-f]{64}$'),
 schema_digest text NOT NULL CHECK(schema_digest ~ '^[0-9a-f]{64}$'),
 cutoff timestamptz NOT NULL CHECK(isfinite(cutoff)),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','claimed','committed','sealed_no_effect')),
 claim_id uuid, claimed_xid8 xid8, backend_pid integer CHECK(backend_pid>0), backend_start timestamptz,
 committed_marker boolean NOT NULL DEFAULT false, sealed_at timestamptz,
 CHECK(state NOT IN ('claimed','committed') OR (claim_id IS NOT NULL AND claimed_xid8 IS NOT NULL
   AND backend_pid IS NOT NULL AND backend_start IS NOT NULL)),
 CHECK(committed_marker=(state='committed')),
 CHECK((state='sealed_no_effect')=(sealed_at IS NOT NULL))
);

CREATE FUNCTION sim_driver_expiry_source.immutable_origin() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $origin$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'origin_delete_denied'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','claim_id','claimed_xid8','backend_pid','backend_start','committed_marker','sealed_at'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','claim_id','claimed_xid8','backend_pid','backend_start','committed_marker','sealed_at'])
 THEN RAISE EXCEPTION 'origin_binding_immutable'; END IF;
 IF OLD.state IN ('committed','sealed_no_effect') THEN RAISE EXCEPTION 'origin_terminal_immutable'; END IF;
 IF NOT ((OLD.state='prepared' AND NEW.state='claimed') OR
         (OLD.state IN ('prepared','claimed') AND NEW.state='sealed_no_effect') OR
         (OLD.state='claimed' AND NEW.state='committed'))
 THEN RAISE EXCEPTION 'origin_transition_denied'; END IF;
 IF OLD.state='claimed' AND ROW(NEW.claim_id,NEW.claimed_xid8,NEW.backend_pid,NEW.backend_start)
  IS DISTINCT FROM ROW(OLD.claim_id,OLD.claimed_xid8,OLD.backend_pid,OLD.backend_start)
 THEN RAISE EXCEPTION 'origin_claim_immutable'; END IF;
 IF NEW.state='committed' AND (NEW.claimed_xid8 IS DISTINCT FROM pg_current_xact_id()
    OR NEW.backend_pid IS DISTINCT FROM pg_backend_pid()
    OR NEW.backend_start IS DISTINCT FROM (SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()))
 THEN RAISE EXCEPTION 'origin_commit_transaction_mismatch'; END IF;
 RETURN NEW;
END $origin$;
CREATE TRIGGER origin_immutable BEFORE UPDATE OR DELETE ON sim_driver_expiry_source.origins
 FOR EACH ROW EXECUTE FUNCTION sim_driver_expiry_source.immutable_origin();

CREATE FUNCTION sim_driver_expiry_source.register_origin(
 p_operation uuid,p_store uuid,p_permit uuid,p_body text,p_schema text,p_cutoff timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $register$
DECLARE r sim_driver_expiry_source.origins%ROWTYPE;
BEGIN
 IF current_database()<>'sim_driver_measurements' OR session_user<>'sim_driver_expiry_control'
 THEN RAISE EXCEPTION 'fixed_control_channel_required'; END IF;
 IF p_operation IS NULL OR p_store IS NULL OR p_permit IS NULL OR p_body IS NULL
  OR p_body !~ '^[0-9a-f]{64}$' OR p_schema IS NULL OR p_schema !~ '^[0-9a-f]{64}$'
  OR p_cutoff IS NULL OR NOT isfinite(p_cutoff)
 THEN RAISE EXCEPTION 'origin_registration_shape'; END IF;
 IF p_store IS DISTINCT FROM (SELECT incarnation FROM sim_driver_expiry_source.store_binding WHERE singleton)
 THEN RAISE EXCEPTION 'store_incarnation_mismatch'; END IF;
 INSERT INTO sim_driver_expiry_source.origins(operation_id,store_incarnation,permit_id,body_digest,schema_digest,cutoff)
 VALUES(p_operation,p_store,p_permit,p_body,p_schema,p_cutoff) ON CONFLICT(operation_id) DO NOTHING;
 SELECT * INTO r FROM sim_driver_expiry_source.origins WHERE operation_id=p_operation FOR UPDATE;
 IF ROW(r.store_incarnation,r.permit_id,r.body_digest,r.schema_digest,r.cutoff)
  IS DISTINCT FROM ROW(p_store,p_permit,p_body,p_schema,p_cutoff)
 THEN RAISE EXCEPTION 'origin_registration_conflict'; END IF;
 RETURN jsonb_build_object('operationId',r.operation_id,'state',r.state,'provisionalInCallerTransaction',true,
   'requiresControlCommitAndFreshReadback',true);
END $register$;

CREATE FUNCTION sim_driver_expiry_source.claim_origin(
 p_operation uuid,p_store uuid,p_xid xid8,p_pid integer,p_start timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $claim$
DECLARE r sim_driver_expiry_source.origins%ROWTYPE;
BEGIN
 IF current_database()<>'sim_driver_measurements' OR session_user<>'sim_driver_expiry_control'
 THEN RAISE EXCEPTION 'fixed_control_channel_required'; END IF;
 SELECT * INTO r FROM sim_driver_expiry_source.origins WHERE operation_id=p_operation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'origin_missing'; END IF;
 IF r.store_incarnation IS DISTINCT FROM p_store OR p_store IS DISTINCT FROM
  (SELECT incarnation FROM sim_driver_expiry_source.store_binding WHERE singleton)
 THEN RAISE EXCEPTION 'store_incarnation_mismatch'; END IF;
 IF r.state<>'prepared' THEN RAISE EXCEPTION 'origin_claim_already_issued_or_closed'; END IF;
 -- Values are observed directly by the owned Root test's origin connection,
 -- not an ordinary app. This is a SQL identity/XID seam, NOT Root authentication.
 IF p_xid IS NULL OR p_xid::text::numeric<3 OR p_pid IS NULL OR p_pid<=0 OR p_start IS NULL
  OR NOT isfinite(p_start) OR NOT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.pid=p_pid
   AND a.backend_start=p_start AND a.datname=current_database() AND a.usename='sim_driver_expiry_exec'
   AND a.xact_start IS NOT NULL AND a.state IN ('active','idle in transaction')
   AND a.backend_xid IS NOT NULL AND a.backend_xid::text::numeric=mod(p_xid::text::numeric,4294967296))
 THEN RAISE EXCEPTION 'origin_backend_not_current'; END IF;
 UPDATE sim_driver_expiry_source.origins SET state='claimed',claim_id=gen_random_uuid(),
  claimed_xid8=p_xid,backend_pid=p_pid,backend_start=p_start WHERE operation_id=p_operation RETURNING * INTO r;
 RETURN jsonb_build_object('operationId',r.operation_id,'claimId',r.claim_id,'state',r.state,
   'provisionalInCallerTransaction',true,'requiresControlCommitAndFreshReadback',true);
END $claim$;

CREATE FUNCTION sim_driver_expiry_source.expire_origin(p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $expire$
DECLARE r sim_driver_expiry_source.origins%ROWTYPE;
BEGIN
 IF current_database()<>'sim_driver_measurements' OR session_user<>'sim_driver_expiry_exec'
 THEN RAISE EXCEPTION 'fixed_executor_channel_required'; END IF;
 SELECT * INTO r FROM sim_driver_expiry_source.origins WHERE operation_id=p_operation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'origin_missing'; END IF;
 IF r.state<>'claimed' THEN RAISE EXCEPTION 'origin_not_claimed_for_expiry'; END IF;
 IF r.store_incarnation IS DISTINCT FROM (SELECT incarnation FROM sim_driver_expiry_source.store_binding WHERE singleton)
  OR r.claimed_xid8 IS DISTINCT FROM pg_current_xact_id() OR r.backend_pid IS DISTINCT FROM pg_backend_pid()
  OR r.backend_start IS DISTINCT FROM (SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid())
 THEN RAISE EXCEPTION 'origin_transaction_mismatch'; END IF;
 -- Same original transaction: both fixed DELETEs, actual unchanged interval/ETA
 -- FK cascades and the marker. No user/account/contributor selector or ledger DML.
 DELETE FROM public.driver_measurement_receipts WHERE owner='cop' AND expires_at<=r.cutoff;
 DELETE FROM public.driver_measurement_revocations WHERE owner='cop' AND expires_at<=r.cutoff;
 UPDATE sim_driver_expiry_source.origins SET state='committed',committed_marker=true WHERE operation_id=p_operation;
 RETURN jsonb_build_object('operationId',r.operation_id,'observed','effects_and_marker_in_origin_transaction',
   'provisionalInCallerTransaction',true,'requiresOriginCommitAndFreshReadback',true);
END $expire$;

CREATE FUNCTION sim_driver_expiry_source.resolve_or_seal(p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='200ms' AS $seal$
DECLARE r sim_driver_expiry_source.origins%ROWTYPE;
BEGIN
 IF current_database()<>'sim_driver_measurements' OR session_user<>'sim_driver_expiry_control'
 THEN RAISE EXCEPTION 'fixed_control_channel_required'; END IF;
 BEGIN
  SELECT * INTO r FROM sim_driver_expiry_source.origins WHERE operation_id=p_operation FOR UPDATE;
 EXCEPTION WHEN lock_not_available THEN
  RETURN jsonb_build_object('operationId',p_operation,'state','pending','reason','origin_busy');
 END;
 IF NOT FOUND THEN RETURN jsonb_build_object('operationId',p_operation,'state','pending','reason','origin_missing'); END IF;
 IF r.store_incarnation IS DISTINCT FROM (SELECT incarnation FROM sim_driver_expiry_source.store_binding WHERE singleton)
 THEN RETURN jsonb_build_object('operationId',p_operation,'state','pending','reason','store_incarnation_mismatch'); END IF;
 IF r.state='committed' THEN
  RETURN jsonb_build_object('operationId',p_operation,'state','origin_commit_known',
    'provisionalInCallerTransaction',true,'requiresControlCommitAndFreshReadback',true);
 END IF;
 IF r.state='sealed_no_effect' THEN
  RETURN jsonb_build_object('operationId',p_operation,'state','origin_no_effect_closed',
    'provisionalInCallerTransaction',true,'requiresControlCommitAndFreshReadback',true);
 END IF;
 UPDATE sim_driver_expiry_source.origins SET state='sealed_no_effect',sealed_at=clock_timestamp() WHERE operation_id=p_operation;
 -- Never publish terminal/quiescence merely from this inner JSON. Control outer
 -- COMMIT plus fresh exact-origin readback is required. Its ROLLBACK leaves the
 -- original executor able to proceed; lost ACK allows only same-origin probing.
 RETURN jsonb_build_object('operationId',p_operation,'state','origin_no_effect_closed',
   'provisionalInCallerTransaction',true,'requiresControlCommitAndFreshReadback',true);
END $seal$;

REVOKE ALL ON ALL TABLES IN SCHEMA sim_driver_expiry_source
 FROM PUBLIC,sim_driver_expiry_control,sim_driver_expiry_exec,driver_measurements_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sim_driver_expiry_source
 FROM PUBLIC,sim_driver_expiry_control,sim_driver_expiry_exec,driver_measurements_runtime;
REVOKE ALL ON SCHEMA sim_driver_expiry_source FROM PUBLIC,driver_measurements_runtime;
RESET ROLE;
GRANT USAGE ON SCHEMA sim_driver_expiry_source TO sim_driver_expiry_control,sim_driver_expiry_exec;
GRANT EXECUTE ON FUNCTION sim_driver_expiry_source.register_origin(uuid,uuid,uuid,text,text,timestamptz) TO sim_driver_expiry_control;
GRANT EXECUTE ON FUNCTION sim_driver_expiry_source.claim_origin(uuid,uuid,xid8,integer,timestamptz) TO sim_driver_expiry_control;
GRANT EXECUTE ON FUNCTION sim_driver_expiry_source.resolve_or_seal(uuid) TO sim_driver_expiry_control;
GRANT EXECUTE ON FUNCTION sim_driver_expiry_source.expire_origin(uuid) TO sim_driver_expiry_exec;
COMMIT;
