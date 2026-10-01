-- Run as migration owner ONLY in a dedicated database through HAProxy.
-- Runtime role: SELECT/INSERT/UPDATE/DELETE on these four tables; no DDL.
BEGIN;
CREATE TABLE IF NOT EXISTS driver_measurement_receipts (
 owner text NOT NULL CHECK(owner='cop'), batch_id uuid NOT NULL,
 contributor_hash char(64) NOT NULL, request_hash char(64) NOT NULL,
 received_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 receipt jsonb NOT NULL, PRIMARY KEY(owner,batch_id)
);
CREATE INDEX IF NOT EXISTS driver_measurement_receipt_expiry ON driver_measurement_receipts(expires_at);
CREATE INDEX IF NOT EXISTS driver_measurement_contributor ON driver_measurement_receipts(owner,contributor_hash);
CREATE TABLE IF NOT EXISTS driver_measurement_intervals (
 owner text NOT NULL, batch_id uuid NOT NULL, measurement_key char(64) NOT NULL,
 dataset text NOT NULL, edge_id text NOT NULL CHECK(edge_id ~ '^[0-9]+$'),
 window_start timestamptz NOT NULL, speed_kph double precision NOT NULL CHECK(speed_kph>0 AND speed_kph<=252),
 distance_m double precision NOT NULL CHECK(distance_m>=10), elapsed_seconds double precision NOT NULL CHECK(elapsed_seconds>=1 AND elapsed_seconds<=10),
 PRIMARY KEY(owner,measurement_key), FOREIGN KEY(owner,batch_id) REFERENCES driver_measurement_receipts ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS driver_measurement_edge_window ON driver_measurement_intervals(dataset,window_start,edge_id);
CREATE TABLE IF NOT EXISTS driver_measurement_eta (
 owner text NOT NULL,batch_id uuid NOT NULL,observation_id uuid NOT NULL,contributor_hash char(64) NOT NULL,dataset text NOT NULL,window_start timestamptz NOT NULL,
 predicted_seconds double precision NOT NULL CHECK(predicted_seconds>0),actual_seconds double precision NOT NULL CHECK(actual_seconds>0),
 PRIMARY KEY(owner,batch_id),UNIQUE(owner,contributor_hash,observation_id),FOREIGN KEY(owner,batch_id) REFERENCES driver_measurement_receipts ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS driver_measurement_revocations (
 owner text NOT NULL CHECK(owner='cop'),contributor_hash char(64) NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(owner,contributor_hash)
);
COMMIT;
