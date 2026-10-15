-- DBv2 forward fix equivalent to the contributor FK in frozen 007, WITHOUT
-- installing Root guarded SQL003..006 or changing runtime DML permissions.
BEGIN;
SET LOCAL lock_timeout='1500ms';
SET LOCAL statement_timeout='15s';
DO $$ BEGIN IF current_database()<>'sim_driver_measurements' THEN RAISE EXCEPTION 'dedicated_driver_database_required'; END IF; END $$;
LOCK TABLE public.driver_measurement_receipts,public.driver_measurement_eta IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='driver_measurements_runtime' AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
 OR (SELECT count(*) FROM pg_class WHERE oid IN ('public.driver_measurement_receipts'::regclass,'public.driver_measurement_eta'::regclass) AND relkind='r' AND pg_get_userbyid(relowner)='driver_measurements_migrator')<>2
 THEN RAISE EXCEPTION 'owned_restricted_driver_tables_required'; END IF;
 IF EXISTS(SELECT 1 FROM public.driver_measurement_eta e LEFT JOIN public.driver_measurement_receipts r ON r.owner=e.owner AND r.batch_id=e.batch_id
  WHERE r.batch_id IS NULL OR e.contributor_hash IS DISTINCT FROM r.contributor_hash)
 THEN RAISE EXCEPTION 'eta_parent_contributor_mismatch' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.driver_measurement_receipts'::regclass AND conname='driver_receipt_contributor_binding_key') THEN
  ALTER TABLE public.driver_measurement_receipts ADD CONSTRAINT driver_receipt_contributor_binding_key UNIQUE(owner,batch_id,contributor_hash) NOT DEFERRABLE;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.driver_measurement_eta'::regclass AND conname='driver_eta_contributor_binding_fkey') THEN
  ALTER TABLE public.driver_measurement_eta ADD CONSTRAINT driver_eta_contributor_binding_fkey FOREIGN KEY(owner,batch_id,contributor_hash)
   REFERENCES public.driver_measurement_receipts(owner,batch_id,contributor_hash) ON DELETE CASCADE NOT DEFERRABLE;
 END IF;
 ALTER TABLE public.driver_measurement_eta DROP CONSTRAINT IF EXISTS driver_measurement_eta_owner_batch_id_fkey;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_index i ON i.indexrelid=k.conindid WHERE k.conrelid='public.driver_measurement_receipts'::regclass
   AND k.conname='driver_receipt_contributor_binding_key' AND k.contype='u' AND k.conkey=ARRAY[1,2,3]::smallint[] AND k.convalidated AND NOT k.condeferrable
   AND i.indisvalid AND i.indisready AND i.indisunique)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.driver_measurement_eta'::regclass AND conname='driver_eta_contributor_binding_fkey'
   AND contype='f' AND conkey=ARRAY[1,2,4]::smallint[] AND confkey=ARRAY[1,2,3]::smallint[] AND confrelid='public.driver_measurement_receipts'::regclass
   AND convalidated AND NOT condeferrable AND confdeltype='c' AND confupdtype='a' AND confmatchtype='s')
 THEN RAISE EXCEPTION 'eta_contributor_binding_postcondition_failed'; END IF;
END $$;
COMMIT;
