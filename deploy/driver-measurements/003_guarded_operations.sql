-- SOURCE ONLY: bounded SQL mechanics for an owned, isolated test database.
-- Not production activation, a grant to the application, Root admission,
-- restore readiness, publication acknowledgement or whole-account completion.
-- The separate bootstrap supplies the empty schema and fixed restricted roles;
-- this source never creates roles, credentials, memberships or a store binding.
-- Original application tables/guard/FK definitions and their migration owner
-- remain unchanged. The frozen expiry-source.sql fixture remains independent.
--
-- Registry bodyDigest is exactly the lowercase hex of PostgreSQL's
-- sha256(convert_to(body::jsonb::text,'UTF8')). This is PG jsonb-text encoding,
-- NOT JSON.stringify or a cross-language canonical JSON claim. Protected Root
-- control must compute/check the digest on the same JSONB value before register;
-- possession of these SQL channels/opaque metadata is NOT Root authority.
-- The DB does not possess the SIM HMAC secret or original COP identity data.
-- Actual Root admission must independently verify that requestHash was derived
-- from the original attested COP manifest and that actor/contributor bindings
-- are authoritative. Hash equality/counts here cannot establish those facts.
-- Transient bodies, never persisted in the origin journal:
-- expire: {contractVersion:'sim-driver-guarded-db-v1'} (cutoff in registry)
-- revoke: {contractVersion,contributorHash}
-- erase/ack: {contractVersion,operationHash,actorHash,requestHash,
--             contributors:[{contributorDay,contributorHash}],checkpointHash}
-- ACK without publicationContext remains pending without changing the ledger.
-- A registered typed context is admitted ONLY by the protected Root registrar
-- after actual private signed-record/current-reference/policy/inventory checks.
-- SQL verifies its binding to the locked actual DB readback, not the signature,
-- provenance, external references or continuing validity of that Root record.
-- A committed origin marker proves this original transaction's effects only;
-- neither marker nor this source-only fixture proves whole-account completion.
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
 THEN RAISE EXCEPTION 'owned_restricted_roles_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname='sim_driver_guard_source' AND r.rolname='sim_driver_guard_owner')
 THEN RAISE EXCEPTION 'owned_source_schema_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='sim_driver_guard_source')
  OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='sim_driver_guard_source')
 THEN RAISE EXCEPTION 'existing_source_not_adopted'; END IF;
 -- The bootstrap's one narrow membership permits owner inspection of executor
 -- pg_stat_activity metadata. Neither runtime nor control can assume it.
 IF NOT pg_has_role('sim_driver_guard_owner','sim_driver_guard_exec','MEMBER')
 THEN RAISE EXCEPTION 'narrow_executor_metadata_membership_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles member_role ON member_role.oid=m.member
    JOIN pg_roles granted_role ON granted_role.oid=m.roleid
    WHERE (member_role.rolname IN ('driver_measurements_runtime','sim_driver_guard_owner',
      'sim_driver_guard_control','sim_driver_guard_exec')
      OR granted_role.rolname IN ('sim_driver_guard_owner','sim_driver_guard_control','sim_driver_guard_exec'))
      AND NOT(member_role.rolname='sim_driver_guard_owner' AND granted_role.rolname='sim_driver_guard_exec'))
 THEN RAISE EXCEPTION 'source_role_isolation_required'; END IF;
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND r.rolname='driver_measurements_migrator'
     AND c.relkind='r' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
     AND c.relname IN ('driver_measurement_receipts','driver_measurement_intervals',
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

-- Fixed privilege profile only; never change actual table ownership/definitions.
GRANT USAGE ON SCHEMA public TO sim_driver_guard_owner;
GRANT SELECT,DELETE ON public.driver_measurement_receipts TO sim_driver_guard_owner;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.driver_measurement_revocations TO sim_driver_guard_owner;
GRANT SELECT ON public.driver_account_erasure_state TO sim_driver_guard_owner;
-- PostgreSQL requires UPDATE on at least one column for SELECT FOR SHARE.
-- The CHECK(singleton) key cannot authorize changes to replay/proof metadata.
GRANT UPDATE(singleton) ON public.driver_account_erasure_state TO sim_driver_guard_owner;
GRANT SELECT,INSERT,UPDATE ON public.driver_account_erasure_operations TO sim_driver_guard_owner;
GRANT SELECT,INSERT ON public.driver_account_erasure_revocations TO sim_driver_guard_owner;

SET ROLE sim_driver_guard_owner;
CREATE TABLE sim_driver_guard_source.store_binding (
 singleton boolean PRIMARY KEY CHECK(singleton), incarnation uuid NOT NULL UNIQUE
);
-- Prebound externally. No generated/default store incarnation may adopt a DB.
CREATE TABLE sim_driver_guard_source.origins (
 operation_id uuid PRIMARY KEY, store_incarnation uuid NOT NULL, permit_id uuid NOT NULL,
 body_digest text NOT NULL CHECK(body_digest ~ '^[0-9a-f]{64}$'),
 schema_digest text NOT NULL CHECK(schema_digest ~ '^[0-9a-f]{64}$'),
 kind text NOT NULL CHECK(kind IN ('expire','revoke','erase','ack')),
 cutoff timestamptz,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','claimed','committed','sealed_no_effect')),
 claimed_xid8 xid8, backend_pid integer CHECK(backend_pid>0), backend_start timestamptz,
 committed_marker boolean NOT NULL DEFAULT false,
 CHECK((kind='expire' AND cutoff IS NOT NULL AND isfinite(cutoff)) OR (kind<>'expire' AND cutoff IS NULL)),
 CHECK(state NOT IN ('claimed','committed') OR (claimed_xid8 IS NOT NULL
   AND backend_pid IS NOT NULL AND backend_start IS NOT NULL)),
 CHECK(committed_marker=(state='committed'))
);

CREATE FUNCTION sim_driver_guard_source.immutable_origin() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $origin$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'origin_delete_denied'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','claimed_xid8','backend_pid','backend_start','committed_marker'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','claimed_xid8','backend_pid','backend_start','committed_marker'])
 THEN RAISE EXCEPTION 'origin_binding_immutable'; END IF;
 IF OLD.state IN ('committed','sealed_no_effect') THEN RAISE EXCEPTION 'origin_terminal_immutable'; END IF;
 IF NOT ((OLD.state='prepared' AND NEW.state='claimed') OR
         (OLD.state IN ('prepared','claimed') AND NEW.state='sealed_no_effect') OR
         (OLD.state='claimed' AND NEW.state='committed'))
 THEN RAISE EXCEPTION 'origin_transition_denied'; END IF;
 IF OLD.state='claimed' AND ROW(NEW.claimed_xid8,NEW.backend_pid,NEW.backend_start)
  IS DISTINCT FROM ROW(OLD.claimed_xid8,OLD.backend_pid,OLD.backend_start)
 THEN RAISE EXCEPTION 'origin_claim_immutable'; END IF;
 IF NEW.state='committed' AND (NEW.claimed_xid8 IS DISTINCT FROM pg_current_xact_id()
    OR NEW.backend_pid IS DISTINCT FROM pg_backend_pid()
    OR NEW.backend_start IS DISTINCT FROM (SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()))
 THEN RAISE EXCEPTION 'origin_commit_transaction_mismatch'; END IF;
 RETURN NEW;
END $origin$;
CREATE TRIGGER origin_immutable BEFORE UPDATE OR DELETE ON sim_driver_guard_source.origins
 FOR EACH ROW EXECUTE FUNCTION sim_driver_guard_source.immutable_origin();

CREATE FUNCTION sim_driver_guard_source.exact_keys(p_value jsonb,p_keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $keys$
 SELECT CASE WHEN jsonb_typeof(p_value)='object' THEN
   p_value ?& p_keys AND (SELECT count(*) FROM jsonb_object_keys(p_value))=cardinality(p_keys)
   ELSE false END
$keys$;

-- Only transient local values; never insert the daily inventory, actor, account
-- or application operation hash into the origin registry or another join table.
CREATE FUNCTION sim_driver_guard_source.validated_contributors(p_body jsonb,p_accepted timestamptz)
RETURNS text[] LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $manifest$
DECLARE item jsonb; day_text text; day_value date; days date[]:=ARRAY[]::date[];
 hashes text[]:=ARRAY[]::text[]; pairs text[]:=ARRAY[]::text[]; pair text;
 today date; latest date; required_day date;
BEGIN
 IF p_accepted IS NULL OR NOT isfinite(p_accepted)
  OR jsonb_typeof(p_body->'contributors') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'guarded_manifest_shape' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(p_body->'contributors') NOT BETWEEN 9 AND 40
 THEN RAISE EXCEPTION 'guarded_manifest_shape' USING ERRCODE='22023'; END IF;
 today:=(p_accepted AT TIME ZONE 'UTC')::date;
 latest:=((p_accepted+interval '30 seconds') AT TIME ZONE 'UTC')::date;
 FOR item IN SELECT value FROM jsonb_array_elements(p_body->'contributors') LOOP
  IF NOT sim_driver_guard_source.exact_keys(item,ARRAY['contributorDay','contributorHash'])
   OR jsonb_typeof(item->'contributorDay') IS DISTINCT FROM 'string'
   OR jsonb_typeof(item->'contributorHash') IS DISTINCT FROM 'string'
   OR (item->>'contributorDay') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   OR (item->>'contributorHash') !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'guarded_manifest_shape' USING ERRCODE='22023'; END IF;
  day_text:=item->>'contributorDay';
  BEGIN day_value:=day_text::date;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
   RAISE EXCEPTION 'guarded_manifest_shape' USING ERRCODE='22023';
  END;
  IF to_char(day_value,'YYYY-MM-DD')<>day_text OR day_value>latest
  THEN RAISE EXCEPTION 'guarded_manifest_coverage' USING ERRCODE='22023'; END IF;
  pair:=day_text||':'||(item->>'contributorHash');
  IF pair=ANY(pairs) THEN RAISE EXCEPTION 'guarded_manifest_duplicate' USING ERRCODE='22023'; END IF;
  pairs:=array_append(pairs,pair); days:=array_append(days,day_value);
  hashes:=array_append(hashes,item->>'contributorHash');
 END LOOP;
 required_day:=today-8;
 WHILE required_day<=latest LOOP
  IF NOT(required_day=ANY(days)) THEN RAISE EXCEPTION 'guarded_manifest_coverage' USING ERRCODE='22023'; END IF;
  required_day:=required_day+1;
 END LOOP;
 -- Sorted distinct contributor locks match ordinary COP intake/revocation.
 RETURN ARRAY(SELECT DISTINCT hash FROM unnest(hashes) AS hash ORDER BY hash);
END $manifest$;

CREATE FUNCTION sim_driver_guard_source.register_origin(
 p_operation uuid,p_store uuid,p_permit uuid,p_kind text,p_body text,p_schema text,p_cutoff timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $register$
DECLARE r sim_driver_guard_source.origins%ROWTYPE;
BEGIN
 IF current_database()<>'sim_driver_measurements' OR session_user<>'sim_driver_guard_control'
 THEN RAISE EXCEPTION 'fixed_control_channel_required'; END IF;
 IF p_operation IS NULL OR p_store IS NULL OR p_permit IS NULL OR p_body IS NULL
  OR p_body !~ '^[0-9a-f]{64}$' OR p_schema IS NULL OR p_schema !~ '^[0-9a-f]{64}$'
  OR p_kind IS NULL OR p_kind NOT IN ('expire','revoke','erase','ack')
  OR (p_kind='expire' AND (p_cutoff IS NULL OR NOT isfinite(p_cutoff) OR p_cutoff>clock_timestamp()))
  OR (p_kind<>'expire' AND p_cutoff IS NOT NULL)
 THEN RAISE EXCEPTION 'origin_registration_shape'; END IF;
 IF p_store IS DISTINCT FROM (SELECT incarnation FROM sim_driver_guard_source.store_binding WHERE singleton)
 THEN RAISE EXCEPTION 'store_incarnation_mismatch'; END IF;
 INSERT INTO sim_driver_guard_source.origins(operation_id,store_incarnation,permit_id,body_digest,schema_digest,kind,cutoff)
 VALUES(p_operation,p_store,p_permit,p_body,p_schema,p_kind,p_cutoff) ON CONFLICT(operation_id) DO NOTHING;
 SELECT * INTO r FROM sim_driver_guard_source.origins WHERE operation_id=p_operation FOR UPDATE;
 IF ROW(r.store_incarnation,r.permit_id,r.body_digest,r.schema_digest,r.kind,r.cutoff)
  IS DISTINCT FROM ROW(p_store,p_permit,p_body,p_schema,p_kind,p_cutoff)
 THEN RAISE EXCEPTION 'origin_registration_conflict' USING ERRCODE='23505'; END IF;
 RETURN jsonb_build_object('operationId',r.operation_id,'state',r.state,'provisionalInCallerTransaction',true,
   'requiresControlCommitAndFreshReadback',true);
END $register$;

CREATE FUNCTION sim_driver_guard_source.claim_origin(
 p_operation uuid,p_store uuid,p_xid xid8,p_pid integer,p_start timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $claim$
DECLARE r sim_driver_guard_source.origins%ROWTYPE;
BEGIN
 IF current_database()<>'sim_driver_measurements' OR session_user<>'sim_driver_guard_control'
 THEN RAISE EXCEPTION 'fixed_control_channel_required'; END IF;
 SELECT * INTO r FROM sim_driver_guard_source.origins WHERE operation_id=p_operation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'origin_missing'; END IF;
 IF r.store_incarnation IS DISTINCT FROM p_store OR p_store IS DISTINCT FROM
  (SELECT incarnation FROM sim_driver_guard_source.store_binding WHERE singleton)
 THEN RAISE EXCEPTION 'store_incarnation_mismatch'; END IF;
 IF r.state<>'prepared' THEN RAISE EXCEPTION 'origin_claim_already_issued_or_closed'; END IF;
 -- The original/control channels supply this descriptor. It is not app consent
 -- or authentication of an external Root authority; full XID is checked on use.
 IF p_xid IS NULL OR p_xid::text::numeric<3 OR p_pid IS NULL OR p_pid<=0 OR p_start IS NULL
  OR NOT isfinite(p_start) OR NOT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.pid=p_pid
   AND a.backend_start=p_start AND a.datname=current_database() AND a.usename='sim_driver_guard_exec'
   AND a.xact_start IS NOT NULL AND a.state IN ('active','idle in transaction')
   AND a.backend_xid IS NOT NULL AND a.backend_xid::text::numeric=mod(p_xid::text::numeric,4294967296))
 THEN RAISE EXCEPTION 'origin_backend_not_current'; END IF;
 UPDATE sim_driver_guard_source.origins SET state='claimed',claimed_xid8=p_xid,
  backend_pid=p_pid,backend_start=p_start WHERE operation_id=p_operation RETURNING * INTO r;
 RETURN jsonb_build_object('operationId',r.operation_id,'state',r.state,
   'provisionalInCallerTransaction',true,'requiresControlCommitAndFreshReadback',true);
END $claim$;

-- Private shared readback builder. No journal/body/identity persistence and no
-- public/runtime EXEC. NULL readback time is sampled after all locks/checks;
-- ACK supplies the accepted context's earlier canonical readback time instead.
CREATE FUNCTION sim_driver_guard_source.publication_readback(p_base jsonb,p_readback_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog SET TimeZone='UTC' SET row_security=off AS $readback$
DECLARE ledger public.driver_account_erasure_operations%ROWTYPE;
 gate public.driver_account_erasure_state%ROWTYPE;
 hashes text[]; contributor text; hash_key text; store_value uuid;
 remaining_count integer; fence_count integer; readback_time text;
BEGIN
 IF NOT sim_driver_guard_source.exact_keys(p_base,ARRAY['contractVersion','operationHash','actorHash','requestHash','contributors','checkpointHash'])
  OR jsonb_typeof(p_base->'contractVersion') IS DISTINCT FROM 'string'
  OR p_base->>'contractVersion'<>'sim-driver-guarded-db-v1'
 THEN RAISE EXCEPTION 'guarded_payload_shape' USING ERRCODE='22023'; END IF;
 FOREACH hash_key IN ARRAY ARRAY['operationHash','actorHash','requestHash','checkpointHash'] LOOP
  IF jsonb_typeof(p_base->hash_key) IS DISTINCT FROM 'string' OR (p_base->>hash_key) !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'guarded_payload_shape' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF p_readback_at IS NOT NULL AND (NOT isfinite(p_readback_at) OR p_readback_at>clock_timestamp())
 THEN RAISE EXCEPTION 'guarded_publication_context_invalid'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('cop:account-erasure:'||(p_base->>'operationHash'),0));
 SELECT * INTO ledger FROM public.driver_account_erasure_operations
  WHERE operation_hash=p_base->>'operationHash' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'guarded_erasure_operation_missing' USING ERRCODE='P0002'; END IF;
 IF ledger.actor_hash::text IS DISTINCT FROM p_base->>'actorHash'
 THEN RAISE EXCEPTION 'guarded_erasure_actor_conflict' USING ERRCODE='P0002'; END IF;
 IF ledger.request_hash::text IS DISTINCT FROM p_base->>'requestHash'
 THEN RAISE EXCEPTION 'guarded_erasure_request_conflict' USING ERRCODE='23505'; END IF;
 hashes:=sim_driver_guard_source.validated_contributors(p_base,ledger.created_at);
 IF ledger.contributor_count<>jsonb_array_length(p_base->'contributors')
 THEN RAISE EXCEPTION 'guarded_erasure_request_conflict' USING ERRCODE='23505'; END IF;
 FOREACH contributor IN ARRAY hashes LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('cop:'||contributor,0));
 END LOOP;
 SELECT * INTO gate FROM public.driver_account_erasure_state WHERE singleton FOR SHARE;
 IF NOT FOUND OR NOT gate.replay_ready OR gate.proof_valid_until IS NULL
  OR gate.proof_valid_until<=clock_timestamp() OR NOT gate.retention_reviewed
  OR NOT gate.publication_fence_verified OR gate.report_protection='unverified'
  OR gate.replay_checkpoint_hash::text IS DISTINCT FROM p_base->>'checkpointHash'
 THEN RAISE EXCEPTION 'guarded_erasure_metadata_not_ready'; END IF;
 SELECT incarnation INTO store_value FROM sim_driver_guard_source.store_binding WHERE singleton FOR SHARE;
 IF store_value IS NULL THEN RAISE EXCEPTION 'store_incarnation_mismatch'; END IF;
 SELECT count(*)::integer INTO fence_count FROM public.driver_account_erasure_revocations
  WHERE owner='cop' AND contributor_hash=ANY(hashes);
 SELECT count(*)::integer INTO remaining_count FROM public.driver_measurement_receipts
  WHERE owner='cop' AND contributor_hash=ANY(hashes);
 IF fence_count<>cardinality(hashes) OR remaining_count<>0
 THEN RAISE EXCEPTION 'guarded_publication_readback_mismatch'; END IF;
 readback_time:=to_char(coalesce(p_readback_at,clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 RETURN jsonb_build_object('storeIncarnation',store_value,
  'payloadDigest',encode(sha256(convert_to(p_base::text,'UTF8')),'hex'),
  'erasureOperationDigest',encode(sha256(convert_to(to_jsonb(ledger)::text,'UTF8')),'hex'),
  'databaseZeroVerified',true,'remainingBatchCount',remaining_count,'exactFenceCount',fence_count,
  'readbackAt',readback_time);
END $readback$;

CREATE FUNCTION sim_driver_guard_source.read_publication_context(p_origin uuid,p_base jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' SET row_security=off SET lock_timeout='1500ms' AS $publication$
DECLARE r sim_driver_guard_source.origins%ROWTYPE; snapshot jsonb;
BEGIN
 IF current_database()<>'sim_driver_measurements' OR session_user<>'sim_driver_guard_control'
 THEN RAISE EXCEPTION 'fixed_control_channel_required'; END IF;
 SELECT * INTO r FROM sim_driver_guard_source.origins WHERE operation_id=p_origin FOR SHARE;
 IF NOT FOUND OR r.kind<>'erase' OR r.state<>'committed' OR NOT r.committed_marker
 THEN RAISE EXCEPTION 'committed_erase_origin_required'; END IF;
 IF r.store_incarnation IS DISTINCT FROM (SELECT incarnation FROM sim_driver_guard_source.store_binding WHERE singleton)
  OR encode(sha256(convert_to(p_base::text,'UTF8')),'hex') IS DISTINCT FROM r.body_digest
 THEN RAISE EXCEPTION 'publication_origin_binding_mismatch'; END IF;
 snapshot:=sim_driver_guard_source.publication_readback(p_base);
 IF snapshot->>'storeIncarnation' IS DISTINCT FROM r.store_incarnation::text
 THEN RAISE EXCEPTION 'store_incarnation_mismatch'; END IF;
 -- Seven scalar fields only. No contributor/account identities or manifest.
 -- This locked SQL readback is not an accepted signed publication reference.
 RETURN snapshot;
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'guarded_publication_context_busy';
END $publication$;

CREATE FUNCTION sim_driver_guard_source.execute_origin(p_operation uuid,p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' SET row_security=off AS $execute$
DECLARE r sim_driver_guard_source.origins%ROWTYPE;
 gate public.driver_account_erasure_state%ROWTYPE;
 ledger public.driver_account_erasure_operations%ROWTYPE;
 contributor text; hashes text[]; accepted_at timestamptz; operation_hash_value text;
 deleted_count integer:=0; removed_temporary_count integer:=0; remaining_count integer:=0;
 result jsonb:='{}'::jsonb; hash_key text; base_body jsonb; context jsonb; snapshot jsonb;
 observed_at timestamptz; context_time text; publication_accepted boolean:=false;
BEGIN
 IF current_database()<>'sim_driver_measurements' OR session_user<>'sim_driver_guard_exec'
 THEN RAISE EXCEPTION 'fixed_executor_channel_required'; END IF;
 SELECT * INTO r FROM sim_driver_guard_source.origins WHERE operation_id=p_operation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'origin_missing'; END IF;
 IF r.state<>'claimed' THEN RAISE EXCEPTION 'origin_not_claimed_for_execution'; END IF;
 IF r.store_incarnation IS DISTINCT FROM (SELECT incarnation FROM sim_driver_guard_source.store_binding WHERE singleton)
  OR r.claimed_xid8 IS DISTINCT FROM pg_current_xact_id() OR r.backend_pid IS DISTINCT FROM pg_backend_pid()
  OR r.backend_start IS DISTINCT FROM (SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid())
 THEN RAISE EXCEPTION 'origin_transaction_mismatch'; END IF;
 IF p_body IS NULL OR jsonb_typeof(p_body)<>'object'
 THEN RAISE EXCEPTION 'guarded_payload_shape' USING ERRCODE='22023'; END IF;
 IF encode(sha256(convert_to(p_body::text,'UTF8')),'hex') IS DISTINCT FROM r.body_digest
 THEN RAISE EXCEPTION 'origin_body_digest_mismatch' USING ERRCODE='23505'; END IF;
 IF jsonb_typeof(p_body->'contractVersion') IS DISTINCT FROM 'string'
  OR p_body->>'contractVersion'<>'sim-driver-guarded-db-v1'
 THEN RAISE EXCEPTION 'guarded_payload_shape' USING ERRCODE='22023'; END IF;

 IF r.kind='expire' THEN
  IF NOT sim_driver_guard_source.exact_keys(p_body,ARRAY['contractVersion'])
  THEN RAISE EXCEPTION 'guarded_payload_shape' USING ERRCODE='22023'; END IF;
  DELETE FROM public.driver_measurement_receipts WHERE owner='cop' AND expires_at<=r.cutoff;
  GET DIAGNOSTICS deleted_count=ROW_COUNT;
  DELETE FROM public.driver_measurement_revocations WHERE owner='cop' AND expires_at<=r.cutoff;
  GET DIAGNOSTICS removed_temporary_count=ROW_COUNT;
  result:=jsonb_build_object('deletedBatchCount',deleted_count,'deletedTemporaryRevocationCount',removed_temporary_count);
 ELSIF r.kind='revoke' THEN
  IF NOT sim_driver_guard_source.exact_keys(p_body,ARRAY['contractVersion','contributorHash'])
   OR jsonb_typeof(p_body->'contributorHash') IS DISTINCT FROM 'string'
   OR (p_body->>'contributorHash') !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'guarded_payload_shape' USING ERRCODE='22023'; END IF;
  contributor:=p_body->>'contributorHash';
  PERFORM pg_advisory_xact_lock(hashtextextended('cop:'||contributor,0));
  INSERT INTO public.driver_measurement_revocations(owner,contributor_hash,expires_at)
   VALUES('cop',contributor,clock_timestamp()+interval '7 days') ON CONFLICT(owner,contributor_hash)
   DO UPDATE SET expires_at=greatest(public.driver_measurement_revocations.expires_at,EXCLUDED.expires_at);
  DELETE FROM public.driver_measurement_receipts WHERE owner='cop' AND contributor_hash=contributor;
  GET DIAGNOSTICS deleted_count=ROW_COUNT;
  result:=jsonb_build_object('deletedBatchCount',deleted_count);
 ELSE
  base_body:=p_body-'publicationContext';
  IF NOT sim_driver_guard_source.exact_keys(base_body,ARRAY['contractVersion','operationHash','actorHash','requestHash','contributors','checkpointHash'])
   OR (r.kind='erase' AND p_body ? 'publicationContext')
  THEN RAISE EXCEPTION 'guarded_payload_shape' USING ERRCODE='22023'; END IF;
  FOREACH hash_key IN ARRAY ARRAY['operationHash','actorHash','requestHash','checkpointHash'] LOOP
   IF jsonb_typeof(p_body->hash_key) IS DISTINCT FROM 'string'
    OR (p_body->>hash_key) !~ '^[0-9a-f]{64}$'
   THEN RAISE EXCEPTION 'guarded_payload_shape' USING ERRCODE='22023'; END IF;
  END LOOP;
  operation_hash_value:=p_body->>'operationHash';
  PERFORM pg_advisory_xact_lock(hashtextextended('cop:account-erasure:'||operation_hash_value,0));
  SELECT * INTO ledger FROM public.driver_account_erasure_operations WHERE operation_hash=operation_hash_value FOR UPDATE;
  IF FOUND THEN
   IF ledger.actor_hash::text IS DISTINCT FROM p_body->>'actorHash'
    THEN RAISE EXCEPTION 'guarded_erasure_actor_conflict' USING ERRCODE='P0002'; END IF;
   IF ledger.request_hash::text IS DISTINCT FROM p_body->>'requestHash'
    THEN RAISE EXCEPTION 'guarded_erasure_request_conflict' USING ERRCODE='23505'; END IF;
   accepted_at:=ledger.created_at;
  ELSE
   IF r.kind='ack' THEN RAISE EXCEPTION 'guarded_erasure_operation_missing' USING ERRCODE='P0002'; END IF;
   accepted_at:=clock_timestamp();
  END IF;
  hashes:=sim_driver_guard_source.validated_contributors(p_body,accepted_at);
  IF ledger.operation_hash IS NOT NULL AND ledger.contributor_count<>jsonb_array_length(p_body->'contributors')
  THEN RAISE EXCEPTION 'guarded_erasure_request_conflict' USING ERRCODE='23505'; END IF;
  FOREACH contributor IN ARRAY hashes LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('cop:'||contributor,0));
  END LOOP;
  -- Check after acquiring the contributor locks: time spent waiting must not
  -- turn an expired metadata proof into permission for a later mutation.
  -- These metadata are necessary SQL preconditions, not proof of Root identity,
  -- actual publication/delivery, authoritative replay or true manifest origin.
  SELECT * INTO gate FROM public.driver_account_erasure_state WHERE singleton FOR SHARE;
  IF NOT FOUND OR NOT gate.replay_ready OR gate.proof_valid_until IS NULL
   OR gate.proof_valid_until<=clock_timestamp() OR NOT gate.retention_reviewed
   OR NOT gate.publication_fence_verified OR gate.report_protection='unverified'
   OR gate.replay_checkpoint_hash::text IS DISTINCT FROM p_body->>'checkpointHash'
  THEN RAISE EXCEPTION 'guarded_erasure_metadata_not_ready'; END IF;
  IF r.kind='erase' THEN
   IF ledger.operation_hash IS NULL THEN
    INSERT INTO public.driver_account_erasure_operations(operation_hash,actor_hash,request_hash,
      contributor_count,created_at,updated_at)
     VALUES(operation_hash_value,p_body->>'actorHash',p_body->>'requestHash',
       jsonb_array_length(p_body->'contributors'),accepted_at,accepted_at);
   END IF;
   INSERT INTO public.driver_account_erasure_revocations(owner,contributor_hash)
    SELECT 'cop',hash FROM unnest(hashes) AS hash ON CONFLICT(owner,contributor_hash) DO NOTHING;
   DELETE FROM public.driver_measurement_receipts WHERE owner='cop' AND contributor_hash=ANY(hashes);
   GET DIAGNOSTICS deleted_count=ROW_COUNT;
  ELSE
   IF EXISTS(SELECT 1 FROM unnest(hashes) AS hash WHERE NOT EXISTS(
      SELECT 1 FROM public.driver_account_erasure_revocations WHERE owner='cop' AND contributor_hash=hash))
   THEN RAISE EXCEPTION 'guarded_erasure_fence_incomplete'; END IF;
  END IF;
  SELECT count(*)::integer INTO remaining_count FROM public.driver_measurement_receipts
   WHERE owner='cop' AND contributor_hash=ANY(hashes);
  IF r.kind='ack' AND p_body ? 'publicationContext' THEN
   context:=p_body->'publicationContext';
   IF NOT sim_driver_guard_source.exact_keys(context,ARRAY['contractVersion','recordId','recordDigest','storeIncarnation',
      'operationDigest','readbackDigest','reportProtection','observedAtUTC'])
    OR jsonb_typeof(context->'contractVersion') IS DISTINCT FROM 'string'
    OR context->>'contractVersion'<>'cop-driver-publication-context-v1'
   THEN RAISE EXCEPTION 'guarded_publication_context_invalid'; END IF;
   FOREACH hash_key IN ARRAY ARRAY['recordId','recordDigest','storeIncarnation','operationDigest','readbackDigest','reportProtection','observedAtUTC'] LOOP
    IF jsonb_typeof(context->hash_key) IS DISTINCT FROM 'string'
    THEN RAISE EXCEPTION 'guarded_publication_context_invalid'; END IF;
   END LOOP;
   FOREACH hash_key IN ARRAY ARRAY['recordDigest','operationDigest','readbackDigest'] LOOP
    IF (context->>hash_key) !~ '^[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'guarded_publication_context_invalid'; END IF;
   END LOOP;
   FOREACH hash_key IN ARRAY ARRAY['recordId','storeIncarnation'] LOOP
    IF (context->>hash_key) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN RAISE EXCEPTION 'guarded_publication_context_invalid'; END IF;
   END LOOP;
   context_time:=context->>'observedAtUTC';
   IF context_time !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    OR context->>'reportProtection' NOT IN ('no_report','enforced_single_writer','shared_generation_fence')
   THEN RAISE EXCEPTION 'guarded_publication_context_invalid'; END IF;
   BEGIN observed_at:=context_time::timestamptz;
   EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'guarded_publication_context_invalid';
   END;
   IF NOT isfinite(observed_at) OR observed_at>clock_timestamp()
    OR to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>context_time
    OR context->>'storeIncarnation' IS DISTINCT FROM r.store_incarnation::text
    OR context->>'reportProtection' IS DISTINCT FROM gate.report_protection
   THEN RAISE EXCEPTION 'guarded_publication_context_invalid'; END IF;
   IF NOT EXISTS(SELECT 1 FROM sim_driver_guard_source.origins WHERE kind='erase' AND state='committed'
      AND committed_marker AND store_incarnation=r.store_incarnation
      AND body_digest=encode(sha256(convert_to(base_body::text,'UTF8')),'hex'))
   THEN RAISE EXCEPTION 'committed_erase_origin_required'; END IF;
   snapshot:=sim_driver_guard_source.publication_readback(base_body,observed_at);
   IF context->>'storeIncarnation' IS DISTINCT FROM snapshot->>'storeIncarnation'
    OR context->>'operationDigest' IS DISTINCT FROM snapshot->>'erasureOperationDigest'
    OR context->>'readbackDigest' IS DISTINCT FROM encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')
   THEN RAISE EXCEPTION 'guarded_publication_readback_mismatch'; END IF;
   -- Only a separately registered ACK body can carry this typed context. Actual
   -- signed publication record, current Root refs/policy/report inventory and
   -- freshness were verified by protected Root control before its acceptance.
   -- No SQL boolean, free-form GUC or context supplied by ordinary app suffices.
   publication_accepted:=true;
  END IF;
  IF r.kind='erase' OR publication_accepted THEN
   UPDATE public.driver_account_erasure_operations SET updated_at=clock_timestamp(),
     deleted_batch_count=deleted_batch_count+deleted_count,remaining_batch_count=remaining_count,
     database_zero_verified=(remaining_count=0),derived_report_acknowledged=publication_accepted,
     status=CASE WHEN publication_accepted THEN 'completed' ELSE 'pending' END,
     replay_checkpoint_hash=p_body->>'checkpointHash'
    WHERE operation_hash=operation_hash_value;
  END IF;
  result:=jsonb_build_object('accountStatus','pending','wholeAccountComplete',false,
    'acceptedAt',accepted_at,'deletedBatchCount',deleted_count,'remainingBatchCount',remaining_count,
    'databaseZeroVerified',remaining_count=0,'derivedReportAcknowledged',publication_accepted);
  IF publication_accepted THEN
   result:=result||jsonb_build_object('accountStatus','completed');
  ELSIF r.kind='ack' THEN
   result:=result||jsonb_build_object('state','pending','reason','root_publication_context_required','effectsApplied',false);
  END IF;
 END IF;
 -- The effects (including the actual existing receipt cascades) and this marker
 -- share exactly the claimed original transaction. Caller COMMIT is not implied.
 UPDATE sim_driver_guard_source.origins SET state='committed',committed_marker=true WHERE operation_id=p_operation;
 RETURN jsonb_build_object('operationId',r.operation_id,'kind',r.kind,
   'observed','effects_and_marker_in_origin_transaction','provisionalInCallerTransaction',true,
   'requiresOriginCommitAndFreshReadback',true)||result;
END $execute$;

CREATE FUNCTION sim_driver_guard_source.resolve_or_seal(p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='200ms' AS $seal$
DECLARE r sim_driver_guard_source.origins%ROWTYPE;
BEGIN
 IF current_database()<>'sim_driver_measurements' OR session_user<>'sim_driver_guard_control'
 THEN RAISE EXCEPTION 'fixed_control_channel_required'; END IF;
 BEGIN
  SELECT * INTO r FROM sim_driver_guard_source.origins WHERE operation_id=p_operation FOR UPDATE;
 EXCEPTION WHEN lock_not_available THEN
  RETURN jsonb_build_object('operationId',p_operation,'state','pending','reason','origin_busy');
 END;
 IF NOT FOUND THEN RETURN jsonb_build_object('operationId',p_operation,'state','pending','reason','origin_missing'); END IF;
 IF r.store_incarnation IS DISTINCT FROM (SELECT incarnation FROM sim_driver_guard_source.store_binding WHERE singleton)
 THEN RETURN jsonb_build_object('operationId',p_operation,'state','pending','reason','store_incarnation_mismatch'); END IF;
 IF r.state='committed' THEN
  RETURN jsonb_build_object('operationId',p_operation,'state','origin_commit_known',
    'provisionalInCallerTransaction',true,'requiresControlCommitAndFreshReadback',true);
 END IF;
 IF r.state='sealed_no_effect' THEN
  RETURN jsonb_build_object('operationId',p_operation,'state','origin_no_effect_closed',
    'provisionalInCallerTransaction',true,'requiresControlCommitAndFreshReadback',true);
 END IF;
 UPDATE sim_driver_guard_source.origins SET state='sealed_no_effect' WHERE operation_id=p_operation;
 RETURN jsonb_build_object('operationId',p_operation,'state','origin_no_effect_closed',
   'provisionalInCallerTransaction',true,'requiresControlCommitAndFreshReadback',true);
END $seal$;

-- An operator diagnostic, NOT an app capability/consent/Root authority signal.
-- Runtime deliberately has no USAGE on this protected source namespace.
CREATE FUNCTION sim_driver_guard_source.runtime_privileges_match() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $privileges$
 SELECT coalesce(current_database()='sim_driver_measurements'
  AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='driver_measurements_runtime' AND rolcanlogin
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  AND NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
    WHERE r.rolname='driver_measurements_runtime')
  AND NOT has_database_privilege('driver_measurements_runtime',current_database(),'CREATE,TEMP')
  AND NOT has_schema_privilege('driver_measurements_runtime','public','CREATE')
  AND NOT has_schema_privilege('driver_measurements_runtime','sim_driver_guard_source','USAGE,CREATE')
  AND (SELECT count(*)=7 AND bool_and(pg_get_userbyid(c.relowner)='driver_measurements_migrator'
      AND has_table_privilege('driver_measurements_runtime',c.oid,'SELECT')
      AND NOT has_table_privilege('driver_measurements_runtime',c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
      AND c.relname IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta',
       'driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations'))
  AND (SELECT bool_and(has_table_privilege('driver_measurements_runtime',c.oid,'INSERT'))
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      AND c.relname IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta'))
  AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    AND c.relname IN ('driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations')
    AND has_table_privilege('driver_measurements_runtime',c.oid,'INSERT'))
  AND has_column_privilege('driver_measurements_runtime','public.driver_measurement_receipts','receipt','UPDATE')
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
      AND c.relname IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta',
       'driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations')
      AND NOT(c.relname='driver_measurement_receipts' AND a.attname='receipt')
      AND has_column_privilege('driver_measurements_runtime',c.oid,a.attnum,'UPDATE'))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
      AND c.relname IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta',
       'driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations')
      AND (has_column_privilege('driver_measurements_runtime',c.oid,a.attnum,'REFERENCES')
       OR (c.relname IN ('driver_measurement_revocations','driver_account_erasure_state',
            'driver_account_erasure_operations','driver_account_erasure_revocations')
         AND has_column_privilege('driver_measurements_runtime',c.oid,a.attnum,'INSERT'))))
  AND has_function_privilege('driver_measurements_runtime','public.driver_account_erasure_receipt_guard()','EXECUTE')
  AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='sim_driver_guard_source' AND p.proname IN ('register_origin','claim_origin','execute_origin','resolve_or_seal','read_publication_context')
      AND has_function_privilege('driver_measurements_runtime',p.oid,'EXECUTE'))
 ,false)
$privileges$;

REVOKE ALL ON ALL TABLES IN SCHEMA sim_driver_guard_source
 FROM PUBLIC,sim_driver_guard_control,sim_driver_guard_exec,driver_measurements_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sim_driver_guard_source
 FROM PUBLIC,sim_driver_guard_control,sim_driver_guard_exec,driver_measurements_runtime;
REVOKE ALL ON SCHEMA sim_driver_guard_source FROM PUBLIC,driver_measurements_runtime;
RESET ROLE;
GRANT USAGE ON SCHEMA sim_driver_guard_source TO sim_driver_guard_control,sim_driver_guard_exec;
GRANT EXECUTE ON FUNCTION sim_driver_guard_source.register_origin(uuid,uuid,uuid,text,text,text,timestamptz) TO sim_driver_guard_control;
GRANT EXECUTE ON FUNCTION sim_driver_guard_source.claim_origin(uuid,uuid,xid8,integer,timestamptz) TO sim_driver_guard_control;
GRANT EXECUTE ON FUNCTION sim_driver_guard_source.resolve_or_seal(uuid) TO sim_driver_guard_control;
GRANT EXECUTE ON FUNCTION sim_driver_guard_source.read_publication_context(uuid,jsonb) TO sim_driver_guard_control;
GRANT EXECUTE ON FUNCTION sim_driver_guard_source.execute_origin(uuid,jsonb) TO sim_driver_guard_exec;
GRANT EXECUTE ON FUNCTION sim_driver_guard_source.runtime_privileges_match() TO sim_driver_guard_control,sim_driver_guard_exec;

-- Scoped prospective profile only: this file must not be installed in a live DB
-- until the separate coordinated Root bridge/cutover has been accepted.
REVOKE CREATE,TEMP ON DATABASE sim_driver_measurements FROM PUBLIC,driver_measurements_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC,driver_measurements_runtime;
REVOKE ALL ON public.driver_measurement_receipts,public.driver_measurement_intervals,public.driver_measurement_eta,
 public.driver_measurement_revocations,public.driver_account_erasure_state,public.driver_account_erasure_operations,
 public.driver_account_erasure_revocations FROM PUBLIC,driver_measurements_runtime;
-- A table-level REVOKE does not remove existing column grants. Clear them too
-- before admitting only receipt JSON acknowledgement updates for normal intake.
DO $columns$
DECLARE rel record; columns text;
BEGIN
 FOR rel IN SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN
   ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta',
    'driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations') LOOP
  SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO columns
   FROM pg_attribute WHERE attrelid=rel.oid AND attnum>0 AND NOT attisdropped;
  EXECUTE format('REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON TABLE public.%2$I FROM PUBLIC,driver_measurements_runtime',columns,rel.relname);
 END LOOP;
END $columns$;
GRANT USAGE ON SCHEMA public TO driver_measurements_runtime;
GRANT SELECT ON public.driver_measurement_receipts,public.driver_measurement_intervals,public.driver_measurement_eta,
 public.driver_measurement_revocations,public.driver_account_erasure_state,public.driver_account_erasure_operations,
 public.driver_account_erasure_revocations TO driver_measurements_runtime;
GRANT INSERT ON public.driver_measurement_receipts,public.driver_measurement_intervals,public.driver_measurement_eta
 TO driver_measurements_runtime;
GRANT UPDATE(receipt) ON public.driver_measurement_receipts TO driver_measurements_runtime;
GRANT EXECUTE ON FUNCTION public.driver_account_erasure_receipt_guard() TO driver_measurements_runtime;
COMMIT;
