-- Apply with a migration identity before starting AI Router. The runtime
-- identity needs SELECT/INSERT/UPDATE on these tables, not CREATE privileges.
BEGIN;
CREATE TABLE IF NOT EXISTS ai_router_request (
  id uuid PRIMARY KEY,
  client_id text NOT NULL,
  user_hash text NOT NULL,
  task_type text NOT NULL,
  model text NOT NULL,
  routing_reason text NOT NULL,
  difficulty text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'success', 'failed')),
  reserved_microusd bigint NOT NULL,
  charged_microusd bigint,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_router_request_created_idx ON ai_router_request (created_at);
CREATE INDEX IF NOT EXISTS ai_router_request_user_idx ON ai_router_request (user_hash, created_at);
CREATE TABLE IF NOT EXISTS ai_router_policy (
  id integer PRIMARY KEY CHECK (id = 1),
  external_allowed boolean NOT NULL DEFAULT false,
  advanced_allowed boolean NOT NULL DEFAULT false,
  daily_microusd bigint NOT NULL,
  monthly_microusd bigint NOT NULL,
  per_user_daily_requests integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_router_policy_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  changed_at timestamptz NOT NULL DEFAULT now(),
  external_allowed boolean NOT NULL,
  advanced_allowed boolean NOT NULL,
  daily_microusd bigint NOT NULL,
  monthly_microusd bigint NOT NULL,
  per_user_daily_requests integer NOT NULL
);
COMMIT;
