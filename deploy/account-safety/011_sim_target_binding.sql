-- Run separately as the existing dedicated target database migrator.
-- The administrator must explicitly insert the accepted binding afterwards.
BEGIN;
DO $$ BEGIN IF current_database() NOT IN ('sim_driver_measurements','sim_ai_router') THEN RAISE EXCEPTION 'Dedicated SIM target required'; END IF; END $$;
CREATE TABLE IF NOT EXISTS public.sim_erasure_dataset_binding (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), guard_store_id uuid NOT NULL,
 store_id uuid NOT NULL, incarnation_id uuid NOT NULL,
 configuration_fingerprint text NOT NULL CHECK(configuration_fingerprint~'^[a-f0-9]{64}$'),
 checkpoint_id uuid NOT NULL, restore_generation bigint NOT NULL CHECK(restore_generation>=1)
);
REVOKE ALL ON public.sim_erasure_dataset_binding FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 role_name:=CASE current_database() WHEN 'sim_driver_measurements' THEN 'driver_measurements_runtime' ELSE 'ai_router_runtime' END;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
  EXECUTE format('GRANT SELECT ON public.sim_erasure_dataset_binding TO %I',role_name);
 END IF;
END $$;
COMMIT;
