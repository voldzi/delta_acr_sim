-- SOURCE ONLY: append one pure source refresh, never enrollment, replay,
-- checkpoint acceptance, policy adoption, target checkpoint renewal or Root
-- readiness. Not applied/activated by this file. No LOGIN, password, profile,
-- membership, binding, installer or production change is supplied.
--
-- Fixed RPC: SELECT cop_guard.refresh_runtime_proof($1::jsonb) AS value;
-- fixed session_user cop_guard_source_refresher, SAME physical metadata session
-- already holding exclusive (hashtext(current_database()),904214). Root must
-- prove its actual held WeakMap lease/global-not-HOLD, current P0/P1, signed
-- files/keyring, self/cohort/host/frontier and target facts before/after. SQL
-- pg_locks is necessary only: it cannot prove Root custody or distinguish the
-- application lifetime of session and transaction advisory acquisitions.
-- Caller must use READ COMMITTED, READ WRITE; SECURITY DEFINER is NOT a way
-- around READ ONLY. Unknown COMMIT/end stays HOLD/probe-only at original IDs.
-- Function SET statement_timeout is not a measured wall-clock bound on an
-- already running statement. Actual Root must keep its client5s query deadline
-- and independent15s watchdog through COMMIT/rollback/end cleanup.
--
-- Exact JSON wire (every listed member required, no extras):
-- {contractVersion:'cop-root-source-refresh-cas-v1',owner,binding,expected,refresh}
-- owner: sim_driver_measurements | sim_ai_router.
-- binding:{guardStoreId,continuityEpoch,protectedConfigId,datasetBindingId,
--   runtimeBindingId,policyGeneration,policyDigest,storeIncarnation}.
-- expected:{identityRowDigest,policyRowDigest,datasetRowDigest,runtimeRowDigest,
--   latestProofId,latestProofJwsDigest,latestProofRowDigest,frontierSequence,
--   frontierDigest,acceptanceId,acceptanceGeneration,acceptanceRowDigest,
--   receiptRowDigest,replayRowDigest,receiptSourceProofRowDigest}.
-- refresh:{proofId,operationId,proofJwsDigest,trustProfileId,observedAtUTC,
--   issuedAtUTC,expiresAtUTC}.
-- All nested values are strings: UUID canonical lowercase v1..8, digests hex64,
-- bigint fields canonical decimal <=9223372036854775807 (generations >=1),
-- timestamps exact UTC milliseconds. SQL policyGeneration is a decimal STRING;
-- this wire does not change the separate Root JWS binding contract.
-- Row digests ALWAYS mean PG encode(sha256(convert_to(to_jsonb(original_row)
-- ::text,'UTF8')),'hex') with explicit UTC, never JS-reencoded JSON.
--
-- Result exact {contractVersion:'cop-root-source-refresh-cas-result-v1',proofId,
-- proofJwsDigest,acceptedJwsRef,acceptedAtUTC,rowDigest}; all strings.
-- Both stored references are derived proofId:proofJwsDigest. accepted_at is
-- DB-derived UTC milliseconds and must strictly advance the old latest row.
-- No input accepted_at, operation kind, arbitrary reference, SQL or path exists.
-- SQLSTATE: shape22023, wrongsession42501, missing/expired/ROstate55000,
-- CAS40001, duplicate23505, actual lock timeout55P03. No retry/upsert fallback.
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog;
SET LOCAL TimeZone='UTC';
DO $preflight$
DECLARE names text[]; role_name text;
BEGIN
 IF current_database()<>'cop_account_safety_guard' OR current_setting('server_version_num')::integer<150000
 THEN RAISE EXCEPTION 'fixed_guard_database_pg15_required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext(current_database()),904214);
 IF EXISTS(SELECT 1 FROM pg_database d,LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
   WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type IN('CREATE','CONNECT','TEMPORARY'))
 THEN RAISE EXCEPTION 'guard_public_access_requires_separate_review'; END IF;
 SELECT array_agg(c.relname::text ORDER BY c.relname) INTO names FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='cop_guard' AND c.relkind IN('r','p');
 IF names IS DISTINCT FROM ARRAY['accepted_runtime_proofs','checkpoint_acceptances','dataset_bindings','fence_journal',
   'guard_identity','owner_receipts','policies','replay_operations','runtime_bindings']
 THEN RAISE EXCEPTION 'exact_guard_foundation_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cop_guard'
   AND c.relkind IN('r','p') AND c.relowner<>'cop_guard_owner'::regrole)
  OR NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='cop_guard' AND nspowner='cop_guard_owner'::regrole)
 THEN RAISE EXCEPTION 'fixed_guard_ownership_required'; END IF;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN('cop_guard_owner','cop_guard_probe','cop_guard_journal_writer',
   'cop_guard_root_enroller','cop_guard_root_checkpoint_acceptor','cop_guard_sim_driver_receipt_writer',
   'cop_guard_sim_ai_receipt_writer','cop_guard_root_reader'))<>8
 THEN RAISE EXCEPTION 'foundation_and_reader_roles_required'; END IF;
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN('cop_guard_owner','cop_guard_probe','cop_guard_journal_writer',
   'cop_guard_root_enroller','cop_guard_root_checkpoint_acceptor','cop_guard_sim_driver_receipt_writer',
   'cop_guard_sim_ai_receipt_writer','cop_guard_root_reader') LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name AND
    (rolsuper OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
  THEN RAISE EXCEPTION 'guard_role_authority_changed'; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='cop_guard.owner_receipts'::regclass AND relrowsecurity)
  OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='cop_guard' AND c.relkind IN('r','p') AND c.relname<>'owner_receipts' AND c.relrowsecurity)
 THEN RAISE EXCEPTION 'fixed_guard_rls_required'; END IF;
 IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='cop_guard' AND NOT t.tgisinternal AND t.tgname IN('immutable_rows','immutable_truncate')
     AND t.tgenabled IN('O','A') AND t.tgfoid='cop_guard.reject_mutation()'::regprocedure)<>18
 THEN RAISE EXCEPTION 'immutable_guard_tables_required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('cop_guard_source_refresh_owner','cop_guard_source_refresher'))
  OR to_regprocedure('cop_guard.refresh_runtime_proof(jsonb)') IS NOT NULL
  OR to_regprocedure('cop_guard.serialize_runtime_proof_insert()') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='cop_guard.accepted_runtime_proofs'::regclass AND tgname='source_refresh_serialize_insert')
 THEN RAISE EXCEPTION 'existing_refresh_objects_require_review'; END IF;
END $preflight$;

CREATE ROLE cop_guard_source_refresh_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 0;
CREATE ROLE cop_guard_source_refresher NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 0;
ALTER ROLE cop_guard_source_refresher SET default_transaction_read_only=on;
ALTER ROLE cop_guard_source_refresher SET statement_timeout='5s';
ALTER ROLE cop_guard_source_refresher SET lock_timeout='1s';
GRANT CONNECT ON DATABASE cop_account_safety_guard TO cop_guard_source_refresher;
GRANT USAGE ON SCHEMA cop_guard TO cop_guard_source_refresh_owner,cop_guard_source_refresher;
GRANT SELECT ON cop_guard.guard_identity,cop_guard.policies,cop_guard.fence_journal,cop_guard.dataset_bindings,
 cop_guard.runtime_bindings,cop_guard.accepted_runtime_proofs,cop_guard.replay_operations,cop_guard.owner_receipts,
 cop_guard.checkpoint_acceptances TO cop_guard_source_refresh_owner,cop_guard_source_refresher;
GRANT INSERT(proof_id,operation_id,operation_kind,binding_id,proof_jws_digest,accepted_jws_ref,trust_profile_id,
 frontier_sequence,frontier_digest,observed_at,issued_at,valid_until,root_evidence_ref,accepted_at)
 ON cop_guard.accepted_runtime_proofs TO cop_guard_source_refresh_owner;
CREATE POLICY source_refresh_receipt_read ON cop_guard.owner_receipts FOR SELECT
 TO cop_guard_source_refresh_owner,cop_guard_source_refresher USING(true);
-- Only the same two fixed read-only pg_catalog observations as reader002.
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system(),pg_catalog.pg_control_checkpoint() TO cop_guard_source_refresher;

-- All inserters, including the original enroller, must serialize BEFORE their
-- row is inserted. Existing session904214 is reentrant in this same backend.
-- No table UPDATE/MAINTAIN grant or voluntary-writer convention substitutes.
CREATE FUNCTION cop_guard.serialize_runtime_proof_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='1000ms' AS $serialize$
BEGIN
 IF current_database()<>'cop_account_safety_guard' OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'fixed_runtime_proof_insert_required' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext(current_database()),904214);
 RETURN NEW;
END $serialize$;
ALTER FUNCTION cop_guard.serialize_runtime_proof_insert() OWNER TO cop_guard_source_refresh_owner;
REVOKE ALL ON FUNCTION cop_guard.serialize_runtime_proof_insert() FROM PUBLIC,cop_guard_source_refresher,cop_guard_root_reader;
CREATE TRIGGER source_refresh_serialize_insert BEFORE INSERT ON cop_guard.accepted_runtime_proofs
 FOR EACH ROW EXECUTE FUNCTION cop_guard.serialize_runtime_proof_insert();
ALTER TABLE cop_guard.accepted_runtime_proofs ENABLE ALWAYS TRIGGER source_refresh_serialize_insert;

CREATE FUNCTION cop_guard.refresh_runtime_proof(p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path=pg_catalog SET TimeZone='UTC' SET row_security=on
SET statement_timeout='3000ms' SET lock_timeout='1000ms' AS $refresh$
DECLARE
 top_keys text[]:=ARRAY['contractVersion','owner','binding','expected','refresh'];
 binding_keys text[]:=ARRAY['guardStoreId','continuityEpoch','protectedConfigId','datasetBindingId','runtimeBindingId','policyGeneration','policyDigest','storeIncarnation'];
 expected_keys text[]:=ARRAY['identityRowDigest','policyRowDigest','datasetRowDigest','runtimeRowDigest','latestProofId','latestProofJwsDigest',
  'latestProofRowDigest','frontierSequence','frontierDigest','acceptanceId','acceptanceGeneration','acceptanceRowDigest','receiptRowDigest','replayRowDigest','receiptSourceProofRowDigest'];
 refresh_keys text[]:=ARRAY['proofId','operationId','proofJwsDigest','trustProfileId','observedAtUTC','issuedAtUTC','expiresAtUTC'];
 k text; owner_name text; binding jsonb; expected jsonb; fresh jsonb;
 i cop_guard.guard_identity%ROWTYPE; p cop_guard.policies%ROWTYPE; d cop_guard.dataset_bindings%ROWTYPE;
 b cop_guard.runtime_bindings%ROWTYPE; a cop_guard.accepted_runtime_proofs%ROWTYPE;
 c cop_guard.checkpoint_acceptances%ROWTYPE; r cop_guard.owner_receipts%ROWTYPE;
 o cop_guard.replay_operations%ROWTYPE; h cop_guard.accepted_runtime_proofs%ROWTYPE;
 inserted cop_guard.accepted_runtime_proofs%ROWTYPE; latest cop_guard.accepted_runtime_proofs%ROWTYPE;
 frontier_seq bigint; frontier_digest text; cleanup_digest text; policy_gen bigint; acceptance_gen bigint;
 observed timestamptz; issued timestamptz; expires timestamptz; accepted timestamptz; db_now timestamptz;
 new_proof_id uuid; new_operation_id uuid; jws_digest text; reference text;
BEGIN
 IF current_database()<>'cop_account_safety_guard' OR session_user<>'cop_guard_source_refresher'
 THEN RAISE EXCEPTION 'fixed_source_refresher_session_required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_read_only')<>'off' OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('session_replication_role')<>'origin' OR pg_is_in_recovery()
 THEN RAISE EXCEPTION 'refresh_read_committed_write_primary_required' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
   AND pid=pg_backend_pid() AND classid=(hashtext(current_database())::bigint & 4294967295)::oid
   AND objid=904214::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted)
 THEN RAISE EXCEPTION 'same_backend_exclusive_904214_required' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='cop_guard.accepted_runtime_proofs'::regclass
   AND tgname='source_refresh_serialize_insert' AND tgenabled='A' AND NOT tgisinternal
   AND tgfoid='cop_guard.serialize_runtime_proof_insert()'::regprocedure)
 THEN RAISE EXCEPTION 'all_proof_insert_serialization_required' USING ERRCODE='55000'; END IF;
 IF p_body IS NULL OR jsonb_typeof(p_body)<>'object' OR octet_length(p_body::text)>8192
  OR NOT(p_body ?& top_keys) OR (SELECT count(*) FROM jsonb_object_keys(p_body))<>cardinality(top_keys)
  OR jsonb_typeof(p_body->'contractVersion') IS DISTINCT FROM 'string' OR p_body->>'contractVersion'<>'cop-root-source-refresh-cas-v1'
  OR jsonb_typeof(p_body->'owner') IS DISTINCT FROM 'string' OR p_body->>'owner' NOT IN('sim_driver_measurements','sim_ai_router')
  OR jsonb_typeof(p_body->'binding') IS DISTINCT FROM 'object' OR jsonb_typeof(p_body->'expected') IS DISTINCT FROM 'object'
  OR jsonb_typeof(p_body->'refresh') IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023'; END IF;
 binding:=p_body->'binding';expected:=p_body->'expected';fresh:=p_body->'refresh';owner_name:=p_body->>'owner';
 IF NOT(binding ?& binding_keys) OR (SELECT count(*) FROM jsonb_object_keys(binding))<>cardinality(binding_keys)
  OR NOT(expected ?& expected_keys) OR (SELECT count(*) FROM jsonb_object_keys(expected))<>cardinality(expected_keys)
  OR NOT(fresh ?& refresh_keys) OR (SELECT count(*) FROM jsonb_object_keys(fresh))<>cardinality(refresh_keys)
 THEN RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023'; END IF;
 FOREACH k IN ARRAY binding_keys LOOP
  IF jsonb_typeof(binding->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 FOREACH k IN ARRAY expected_keys LOOP
  IF jsonb_typeof(expected->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 FOREACH k IN ARRAY refresh_keys LOOP
  IF jsonb_typeof(fresh->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['guardStoreId','continuityEpoch','protectedConfigId','datasetBindingId','runtimeBindingId','storeIncarnation'] LOOP
  IF binding->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['latestProofId','acceptanceId'] LOOP
  IF expected->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['proofId','operationId'] LOOP
  IF fresh->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF binding->>'policyDigest' !~ '^[0-9a-f]{64}$' OR fresh->>'proofJwsDigest' !~ '^[0-9a-f]{64}$'
  OR fresh->>'trustProfileId' !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
 THEN RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023'; END IF;
 FOREACH k IN ARRAY ARRAY['identityRowDigest','policyRowDigest','datasetRowDigest','runtimeRowDigest','latestProofJwsDigest','latestProofRowDigest',
   'frontierDigest','acceptanceRowDigest','receiptRowDigest','replayRowDigest','receiptSourceProofRowDigest'] LOOP
  IF expected->>k !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF binding->>'policyGeneration' !~ '^[1-9][0-9]{0,18}$' OR expected->>'acceptanceGeneration' !~ '^[1-9][0-9]{0,18}$'
  OR expected->>'frontierSequence' !~ '^(0|[1-9][0-9]{0,18})$'
 THEN RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023'; END IF;
 IF (binding->>'policyGeneration')::numeric>9223372036854775807 OR (expected->>'acceptanceGeneration')::numeric>9223372036854775807
  OR (expected->>'frontierSequence')::numeric>9223372036854775807
 THEN RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023'; END IF;
 FOREACH k IN ARRAY ARRAY['observedAtUTC','issuedAtUTC','expiresAtUTC'] LOOP
  IF fresh->>k !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  THEN RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 BEGIN
  observed:=(fresh->>'observedAtUTC')::timestamptz;issued:=(fresh->>'issuedAtUTC')::timestamptz;expires:=(fresh->>'expiresAtUTC')::timestamptz;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023';
 END;
 IF NOT isfinite(observed) OR NOT isfinite(issued) OR NOT isfinite(expires)
  OR to_char(observed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>fresh->>'observedAtUTC'
  OR to_char(issued AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>fresh->>'issuedAtUTC'
  OR to_char(expires AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>fresh->>'expiresAtUTC'
 THEN RAISE EXCEPTION 'source_refresh_request_invalid' USING ERRCODE='22023'; END IF;
 policy_gen:=(binding->>'policyGeneration')::bigint;acceptance_gen:=(expected->>'acceptanceGeneration')::bigint;
 new_proof_id:=(fresh->>'proofId')::uuid;new_operation_id:=(fresh->>'operationId')::uuid;jws_digest:=fresh->>'proofJwsDigest';
 reference:=new_proof_id::text||':'||jws_digest;

 SELECT * INTO i FROM cop_guard.guard_identity WHERE singleton;
 SELECT * INTO p FROM cop_guard.policies ORDER BY policy_generation DESC LIMIT 1;
 SELECT * INTO d FROM cop_guard.dataset_bindings WHERE dataset_binding_id=(binding->>'datasetBindingId')::uuid;
 SELECT * INTO b FROM cop_guard.runtime_bindings WHERE binding_id=(binding->>'runtimeBindingId')::uuid;
 SELECT * INTO a FROM cop_guard.accepted_runtime_proofs WHERE binding_id=b.binding_id
  ORDER BY accepted_at DESC,issued_at DESC,proof_id DESC LIMIT 1;
 SELECT * INTO c FROM cop_guard.checkpoint_acceptances WHERE dataset_binding_id=d.dataset_binding_id ORDER BY generation DESC LIMIT 1;
 SELECT * INTO r FROM cop_guard.owner_receipts WHERE receipt_id=c.receipt_id;
 SELECT * INTO o FROM cop_guard.replay_operations WHERE operation_id=r.replay_operation_id;
 SELECT * INTO h FROM cop_guard.accepted_runtime_proofs WHERE proof_id=r.source_proof_id;
 IF i.guard_store_id IS NULL OR p.policy_generation IS NULL OR d.dataset_binding_id IS NULL OR b.binding_id IS NULL
  OR a.proof_id IS NULL OR c.acceptance_id IS NULL OR r.receipt_id IS NULL OR o.operation_id IS NULL OR h.proof_id IS NULL
 THEN RAISE EXCEPTION 'source_refresh_current_metadata_required' USING ERRCODE='55000'; END IF;
 IF i.application_id<>'cop' OR i.guard_contract_version<>'cop-account-safety-runtime-v1' OR i.stream_scope_id<>'cop-global-fences-v1'
  OR i.guard_store_id IS DISTINCT FROM (binding->>'guardStoreId')::uuid OR p.guard_store_id<>i.guard_store_id
  OR p.policy_id<>'cop-jizda-only-sim-preserved-v1' OR p.policy_generation<>policy_gen OR p.policy_digest<>binding->>'policyDigest'
  OR p.protected_config_id IS DISTINCT FROM (binding->>'protectedConfigId')::uuid OR p.continuity_epoch IS DISTINCT FROM (binding->>'continuityEpoch')::uuid
  OR d.guard_store_id<>i.guard_store_id OR d.continuity_epoch<>p.continuity_epoch OR d.owner_id<>owner_name
  OR d.target_incarnation_id IS DISTINCT FROM (binding->>'storeIncarnation')::uuid
  OR d.projection_contract_id<>(CASE WHEN owner_name='sim_driver_measurements' THEN 'cop-sim-driver-projection-v1' ELSE 'cop-sim-ai-projection-v1' END)
  OR b.dataset_binding_id<>d.dataset_binding_id OR b.owner_id<>owner_name OR b.policy_generation<>p.policy_generation
  OR a.binding_id<>b.binding_id OR a.proof_id IS DISTINCT FROM (expected->>'latestProofId')::uuid
  OR a.proof_jws_digest<>expected->>'latestProofJwsDigest' OR a.accepted_jws_ref<>a.proof_id::text||':'||a.proof_jws_digest
  OR fresh->>'trustProfileId'<>a.trust_profile_id
 THEN RAISE EXCEPTION 'source_refresh_binding_cas_failed' USING ERRCODE='40001'; END IF;
 IF encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex')<>expected->>'identityRowDigest'
  OR encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')<>expected->>'policyRowDigest'
  OR encode(sha256(convert_to(to_jsonb(d)::text,'UTF8')),'hex')<>expected->>'datasetRowDigest'
  OR encode(sha256(convert_to(to_jsonb(b)::text,'UTF8')),'hex')<>expected->>'runtimeRowDigest'
  OR encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex')<>expected->>'latestProofRowDigest'
  OR encode(sha256(convert_to(to_jsonb(c)::text,'UTF8')),'hex')<>expected->>'acceptanceRowDigest'
  OR encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')<>expected->>'receiptRowDigest'
  OR encode(sha256(convert_to(to_jsonb(o)::text,'UTF8')),'hex')<>expected->>'replayRowDigest'
  OR encode(sha256(convert_to(to_jsonb(h)::text,'UTF8')),'hex')<>expected->>'receiptSourceProofRowDigest'
 THEN RAISE EXCEPTION 'source_refresh_row_digest_cas_failed' USING ERRCODE='40001'; END IF;
 SELECT sequence,entry_digest INTO frontier_seq,frontier_digest FROM cop_guard.fence_journal ORDER BY sequence DESC LIMIT 1;
 frontier_seq:=coalesce(frontier_seq,0);frontier_digest:=coalesce(frontier_digest,i.initial_prefix_digest);
 IF frontier_seq<>(expected->>'frontierSequence')::bigint OR frontier_digest<>expected->>'frontierDigest'
  OR a.frontier_sequence<>frontier_seq OR a.frontier_digest<>frontier_digest
  OR c.acceptance_id IS DISTINCT FROM (expected->>'acceptanceId')::uuid OR c.generation<>acceptance_gen
  OR c.dataset_binding_id<>d.dataset_binding_id OR c.policy_generation<>p.policy_generation OR c.policy_digest<>p.policy_digest
  OR c.protected_config_id<>p.protected_config_id OR c.admission_policy_id<>p.admission_policy_id OR c.continuity_epoch<>p.continuity_epoch
  OR c.root_evidence_ref<>c.acceptance_id::text OR c.accepted_frontier_sequence<>frontier_seq OR c.accepted_frontier_digest<>frontier_digest
  OR c.fence_sequence<>frontier_seq OR c.fence_digest<>frontier_digest OR r.owner_id<>owner_name OR r.binding_id<>b.binding_id
  OR r.production_authorization OR r.replay_operation_id<>o.operation_id OR r.source_proof_id<>o.source_proof_id
  OR o.binding_id<>b.binding_id OR h.proof_id<>r.source_proof_id OR h.binding_id<>b.binding_id
  OR h.operation_id<>o.operation_id OR h.operation_kind<>o.operation_kind OR h.proof_jws_digest<>r.source_proof_jws_digest
  OR h.accepted_jws_ref<>h.proof_id::text||':'||h.proof_jws_digest
  OR h.frontier_sequence<>frontier_seq OR h.frontier_digest<>frontier_digest
  OR c.cleanup_status NOT IN('pending','complete') OR c.cleanup_status<>r.cleanup_status
  OR c.cleanup_sequence<>r.cleanup_sequence OR c.cleanup_digest<>r.cleanup_digest
  OR r.fence_sequence<>frontier_seq OR r.fence_digest<>frontier_digest OR c.cleanup_sequence>frontier_seq
  OR (c.cleanup_status='complete' AND c.cleanup_sequence<>frontier_seq)
 THEN RAISE EXCEPTION 'source_refresh_checkpoint_frontier_cas_failed' USING ERRCODE='40001'; END IF;
 IF c.cleanup_sequence=0 THEN cleanup_digest:=i.initial_prefix_digest;
 ELSE SELECT entry_digest INTO cleanup_digest FROM cop_guard.fence_journal WHERE sequence=c.cleanup_sequence;END IF;
 IF cleanup_digest IS NULL OR cleanup_digest<>c.cleanup_digest
 THEN RAISE EXCEPTION 'source_refresh_cleanup_prefix_cas_failed' USING ERRCODE='40001'; END IF;
 db_now:=clock_timestamp();
 IF a.observed_at>a.issued_at OR a.issued_at>db_now OR a.valid_until<=db_now OR a.valid_until-a.observed_at>interval '30 seconds'
  OR date_trunc('milliseconds',a.observed_at)<>a.observed_at OR date_trunc('milliseconds',a.issued_at)<>a.issued_at
  OR date_trunc('milliseconds',a.valid_until)<>a.valid_until
  OR observed<a.observed_at OR issued<a.issued_at OR observed>issued OR issued>=expires OR issued>db_now OR expires<=db_now
  OR db_now-observed>interval '5 seconds' OR expires-observed>interval '30 seconds'
 THEN RAISE EXCEPTION 'source_refresh_original_and_new_proof_must_be_current' USING ERRCODE='55000'; END IF;
 IF new_proof_id=a.proof_id OR new_operation_id=a.operation_id
  OR EXISTS(SELECT 1 FROM cop_guard.accepted_runtime_proofs x WHERE x.proof_id=new_proof_id OR x.operation_id=new_operation_id)
  OR EXISTS(SELECT 1 FROM cop_guard.replay_operations x WHERE x.operation_id=new_operation_id)
 THEN RAISE EXCEPTION 'source_refresh_original_ids_consumed' USING ERRCODE='23505'; END IF;
 accepted:=date_trunc('milliseconds',clock_timestamp());
 IF accepted<=a.accepted_at THEN RAISE EXCEPTION 'source_refresh_database_clock_not_advanced' USING ERRCODE='55000'; END IF;
 INSERT INTO cop_guard.accepted_runtime_proofs(proof_id,operation_id,operation_kind,binding_id,proof_jws_digest,accepted_jws_ref,
  trust_profile_id,frontier_sequence,frontier_digest,observed_at,issued_at,valid_until,root_evidence_ref,accepted_at)
 VALUES(new_proof_id,new_operation_id,'refresh',b.binding_id,jws_digest,reference,a.trust_profile_id,frontier_seq,frontier_digest,
  observed,issued,expires,reference,accepted) RETURNING * INTO inserted;
 SELECT * INTO latest FROM cop_guard.accepted_runtime_proofs WHERE binding_id=b.binding_id ORDER BY accepted_at DESC,issued_at DESC,proof_id DESC LIMIT 1;
 IF latest.proof_id<>inserted.proof_id OR latest.proof_jws_digest<>jws_digest
  OR (SELECT max(policy_generation) FROM cop_guard.policies)<>p.policy_generation
  OR (SELECT acceptance_id FROM cop_guard.checkpoint_acceptances WHERE dataset_binding_id=d.dataset_binding_id ORDER BY generation DESC LIMIT 1)<>c.acceptance_id
  OR coalesce((SELECT sequence FROM cop_guard.fence_journal ORDER BY sequence DESC LIMIT 1),0)<>frontier_seq
  OR coalesce((SELECT entry_digest FROM cop_guard.fence_journal ORDER BY sequence DESC LIMIT 1),i.initial_prefix_digest)<>frontier_digest
 THEN RAISE EXCEPTION 'source_refresh_post_insert_cas_failed' USING ERRCODE='40001'; END IF;
 IF a.valid_until<=clock_timestamp() OR inserted.valid_until<=clock_timestamp()
 THEN RAISE EXCEPTION 'source_refresh_proof_expired_before_return' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('contractVersion','cop-root-source-refresh-cas-result-v1','proofId',inserted.proof_id::text,
  'proofJwsDigest',inserted.proof_jws_digest,'acceptedJwsRef',inserted.accepted_jws_ref,
  'acceptedAtUTC',to_char(inserted.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'rowDigest',encode(sha256(convert_to(to_jsonb(inserted)::text,'UTF8')),'hex'));
END $refresh$;
ALTER FUNCTION cop_guard.refresh_runtime_proof(jsonb) OWNER TO cop_guard_source_refresh_owner;
REVOKE ALL ON FUNCTION cop_guard.refresh_runtime_proof(jsonb) FROM PUBLIC,cop_guard_root_reader;
GRANT EXECUTE ON FUNCTION cop_guard.refresh_runtime_proof(jsonb) TO cop_guard_source_refresher;
DO $postflight$
DECLARE role_name text; rel record;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['cop_guard_source_refresh_owner','cop_guard_source_refresher'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
    AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit=0)
   OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=role_name::regrole OR roleid=role_name::regrole)
   OR has_schema_privilege(role_name,'cop_guard','CREATE') OR has_schema_privilege(role_name,'public','CREATE')
   OR has_database_privilege(role_name,current_database(),'CREATE,TEMPORARY')
  THEN RAISE EXCEPTION 'source_refresh_role_isolation_failed'; END IF;
  FOR rel IN SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cop_guard' AND c.relkind IN('r','p') LOOP
   IF has_table_privilege(role_name,rel.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege(role_name,rel.oid,'UPDATE,REFERENCES')
    OR (role_name='cop_guard_source_refresher' OR rel.relname<>'accepted_runtime_proofs') AND
      (has_table_privilege(role_name,rel.oid,'INSERT') OR has_any_column_privilege(role_name,rel.oid,'INSERT'))
   THEN RAISE EXCEPTION 'source_refresh_raw_dml_forbidden'; END IF;
  END LOOP;
 END LOOP;
 IF has_function_privilege('cop_guard_root_reader','cop_guard.refresh_runtime_proof(jsonb)','EXECUTE')
  OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='cop_guard'
    AND p.oid<>'cop_guard.refresh_runtime_proof(jsonb)'::regprocedure
    AND has_function_privilege('cop_guard_source_refresher',p.oid,'EXECUTE'))
 THEN RAISE EXCEPTION 'source_refresh_rpc_only_required'; END IF;
END $postflight$;
COMMIT;
