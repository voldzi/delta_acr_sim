-- Apply using the migration account; do not grant DDL to the runtime account.
-- API keys are encrypted by the Router before INSERT. The encryption key is
-- stored outside PostgreSQL and its backups.
BEGIN;
CREATE TABLE IF NOT EXISTS ai_router_user_key (
  user_hash text PRIMARY KEY,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  fingerprint text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_router_user_key_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_hash text NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'replaced', 'removed')),
  fingerprint text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_router_billing_request (
  id uuid PRIMARY KEY,
  billing_source text NOT NULL CHECK (billing_source IN ('user_openai_key', 'sim_project')),
  payer_hash text NOT NULL,
  actor_hash text NOT NULL,
  credential_fingerprint text NOT NULL,
  provider_project_id text,
  task_type text NOT NULL CHECK (task_type IN ('cop_chat', 'sim_izs_summary')),
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'success', 'failed', 'uncertain')),
  reserved_microusd bigint NOT NULL CHECK (reserved_microusd >= 0),
  estimated_microusd bigint,
  input_tokens integer,
  output_tokens integer,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_router_billing_scope_idx ON ai_router_billing_request (billing_source, payer_hash, created_at);
CREATE INDEX IF NOT EXISTS ai_router_billing_actor_idx ON ai_router_billing_request (actor_hash, created_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_router_user_key TO ai_router_runtime;
GRANT INSERT ON ai_router_user_key_audit TO ai_router_runtime;
GRANT USAGE, SELECT ON SEQUENCE ai_router_user_key_audit_id_seq TO ai_router_runtime;
GRANT SELECT, INSERT, UPDATE ON ai_router_billing_request TO ai_router_runtime;
COMMIT;
