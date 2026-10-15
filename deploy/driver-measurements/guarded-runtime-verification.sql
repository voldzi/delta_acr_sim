-- Diagnostic only. Not Root admission, restore readiness or activation.
-- Safe to run by an operator through the fixed HAProxy endpoint, without runtime
-- credentials. No function body supplied by the database is executed here.
BEGIN READ ONLY;
SET LOCAL search_path=pg_catalog;
SELECT coalesce(
 current_database()='sim_driver_measurements'
 AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='driver_measurements_runtime'
   AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
   AND NOT rolreplication AND NOT rolbypassrls)
 AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sim_driver_guard_owner'
   AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
   AND NOT rolreplication AND NOT rolbypassrls)
 AND (SELECT count(*)=2 FROM pg_roles WHERE rolname IN ('sim_driver_guard_control','sim_driver_guard_exec')
   AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
   AND NOT rolreplication AND NOT rolbypassrls)
 AND NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
   WHERE r.rolname='driver_measurements_runtime')
 AND NOT has_database_privilege('driver_measurements_runtime',current_database(),'CREATE,TEMP')
 AND NOT has_schema_privilege('driver_measurements_runtime','public','CREATE')
 AND NOT has_schema_privilege('driver_measurements_runtime','sim_driver_guard_source','USAGE,CREATE')
 AND (SELECT count(*)=7 AND bool_and(pg_get_userbyid(c.relowner)='driver_measurements_migrator')
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
   AND c.relname IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta',
     'driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations'))
 AND (SELECT bool_and(has_table_privilege('driver_measurements_runtime',c.oid,'SELECT'))
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
   AND c.relname IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta',
     'driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations'))
 AND (SELECT bool_and(has_table_privilege('driver_measurements_runtime',c.oid,'INSERT'))
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
   AND c.relname IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
   AND c.relname IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta',
     'driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations')
   AND has_table_privilege('driver_measurements_runtime',c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
   AND c.relname IN ('driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations')
   AND has_table_privilege('driver_measurements_runtime',c.oid,'INSERT'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
   AND c.relname IN ('driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations')
   AND has_any_column_privilege('driver_measurements_runtime',c.oid,'INSERT'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
   AND c.relname IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta',
     'driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations')
   AND has_any_column_privilege('driver_measurements_runtime',c.oid,'REFERENCES'))
 AND has_column_privilege('driver_measurements_runtime','public.driver_measurement_receipts','receipt','UPDATE')
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
   AND c.relname IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta',
     'driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations')
   AND NOT(c.relname='driver_measurement_receipts' AND a.attname='receipt')
   AND has_column_privilege('driver_measurements_runtime',c.oid,a.attnum,'UPDATE'))
 AND EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   WHERE t.tgrelid='public.driver_measurement_receipts'::regclass
   AND t.tgname='driver_account_erasure_receipt_guard' AND NOT t.tgisinternal
   AND t.tgenabled IN ('O','A') AND t.tgtype=23 AND NOT p.prosecdef
   AND position('driver-account-erasure-receipt-guard-v1' IN pg_get_functiondef(p.oid))>0)
 AND (SELECT count(*)=2 FROM pg_constraint WHERE contype='f' AND convalidated AND NOT condeferrable
   AND confdeltype='c' AND confrelid='public.driver_measurement_receipts'::regclass
   AND conrelid IN ('public.driver_measurement_intervals'::regclass,'public.driver_measurement_eta'::regclass))
 AND has_function_privilege('driver_measurements_runtime','public.driver_account_erasure_receipt_guard()','EXECUTE')
 AND (SELECT count(*)=5 AND bool_and(p.prosecdef AND pg_get_userbyid(p.proowner)='sim_driver_guard_owner'
     AND NOT has_function_privilege('driver_measurements_runtime',p.oid,'EXECUTE'))
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='sim_driver_guard_source' AND p.proname IN ('register_origin','claim_origin','execute_origin','resolve_or_seal','read_publication_context'))
,false) AS guarded_runtime_privileges_match;
ROLLBACK;
