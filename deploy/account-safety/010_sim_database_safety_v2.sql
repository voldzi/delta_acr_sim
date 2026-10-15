-- Explicit migrator installation in the independent guard database only.
-- No enrollment, role creation, production credentials or legacy-table changes.
BEGIN;
DO $$ BEGIN IF current_database()<>'cop_account_safety_guard' THEN RAISE EXCEPTION 'Independent guard database required'; END IF; END $$;
CREATE SCHEMA IF NOT EXISTS sim_erasure_guard_v2;
REVOKE ALL ON SCHEMA sim_erasure_guard_v2 FROM PUBLIC;
CREATE TABLE IF NOT EXISTS sim_erasure_guard_v2.store (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 store_id uuid NOT NULL UNIQUE, configuration_fingerprint text NOT NULL CHECK(configuration_fingerprint~'^[a-f0-9]{64}$')
);
CREATE TABLE IF NOT EXISTS sim_erasure_guard_v2.owner_binding (
 owner text PRIMARY KEY CHECK(owner IN ('sim_measurements','ai_router')),
 guard_store_id uuid NOT NULL REFERENCES sim_erasure_guard_v2.store(store_id),
 target_store_id uuid NOT NULL, incarnation_id uuid NOT NULL,
 configuration_fingerprint text NOT NULL CHECK(configuration_fingerprint~'^[a-f0-9]{64}$'),
 checkpoint_id uuid NOT NULL, restore_generation bigint NOT NULL CHECK(restore_generation>=1),
 state text NOT NULL DEFAULT 'quarantined' CHECK(state IN ('quarantined','ready')),
 replay_sequence bigint NOT NULL DEFAULT 0 CHECK(replay_sequence>=0)
);
CREATE TABLE IF NOT EXISTS sim_erasure_guard_v2.tombstone (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 owner text NOT NULL REFERENCES sim_erasure_guard_v2.owner_binding(owner), operation_id uuid NOT NULL,
 actor_hash text NOT NULL CHECK(actor_hash~'^[a-f0-9]{64}$'), request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=1048576),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner,operation_id), UNIQUE(owner,actor_hash),
 CHECK((owner='sim_measurements' AND payload-ARRAY['operationHash','contributorHashes','contributorCount']='{}'::jsonb
   AND payload?'operationHash' AND payload?'contributorHashes' AND payload?'contributorCount'
   AND payload->>'operationHash'~'^[a-f0-9]{64}$' AND jsonb_typeof(payload->'contributorHashes')='array')
 OR (owner='ai_router' AND payload-ARRAY['targetHash']='{}'::jsonb AND payload?'targetHash' AND payload->>'targetHash'~'^[a-f0-9]{64}$'))
);
CREATE OR REPLACE FUNCTION sim_erasure_guard_v2.immutable_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'sim_erasure_tombstone_immutable'; END $$;
DROP TRIGGER IF EXISTS immutable_tombstone ON sim_erasure_guard_v2.tombstone;
CREATE TRIGGER immutable_tombstone BEFORE UPDATE OR DELETE OR TRUNCATE ON sim_erasure_guard_v2.tombstone
FOR EACH STATEMENT EXECUTE FUNCTION sim_erasure_guard_v2.immutable_tombstone();
REVOKE ALL ON ALL TABLES IN SCHEMA sim_erasure_guard_v2 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sim_erasure_guard_v2 FROM PUBLIC;
ALTER TABLE sim_erasure_guard_v2.owner_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE sim_erasure_guard_v2.tombstone ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT * FROM (VALUES ('sim_measurements','sim_measurements_guard_runtime'),('ai_router','ai_router_guard_runtime')) AS x(owner,role_name) LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=item.role_name) THEN
   EXECUTE format('GRANT USAGE ON SCHEMA sim_erasure_guard_v2 TO %I',item.role_name);
   EXECUTE format('GRANT SELECT ON sim_erasure_guard_v2.store,sim_erasure_guard_v2.owner_binding,sim_erasure_guard_v2.tombstone TO %I',item.role_name);
   EXECUTE format('GRANT UPDATE(replay_sequence) ON sim_erasure_guard_v2.owner_binding TO %I',item.role_name);
   EXECUTE format('GRANT INSERT(owner,operation_id,actor_hash,request_hash,payload) ON sim_erasure_guard_v2.tombstone TO %I',item.role_name);
   EXECUTE format('GRANT USAGE ON SEQUENCE sim_erasure_guard_v2.tombstone_sequence_seq TO %I',item.role_name);
   EXECUTE format('DROP POLICY IF EXISTS %I ON sim_erasure_guard_v2.owner_binding',item.role_name);
   EXECUTE format('CREATE POLICY %I ON sim_erasure_guard_v2.owner_binding TO %I USING(owner=%L) WITH CHECK(owner=%L)',item.role_name,item.role_name,item.owner,item.owner);
   EXECUTE format('DROP POLICY IF EXISTS %I ON sim_erasure_guard_v2.tombstone',item.role_name);
   EXECUTE format('CREATE POLICY %I ON sim_erasure_guard_v2.tombstone TO %I USING(owner=%L) WITH CHECK(owner=%L)',item.role_name,item.role_name,item.owner,item.owner);
  END IF;
 END LOOP;
END $$;
COMMIT;
