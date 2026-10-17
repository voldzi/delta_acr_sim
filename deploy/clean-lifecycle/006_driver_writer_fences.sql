-- Owner-only, NEW clean dataset. Ordinary interval writes also hold the same
-- account lock in the actual driver's commit transaction; receipt/ETA FKs remain.
BEGIN;
CREATE TRIGGER clean_user_fence BEFORE INSERT OR UPDATE ON public.driver_measurement_receipts FOR EACH ROW EXECUTE FUNCTION sim_clean.fence('driver_contributor','contributor_hash');
CREATE TRIGGER clean_user_fence BEFORE INSERT OR UPDATE ON public.driver_measurement_eta FOR EACH ROW EXECUTE FUNCTION sim_clean.fence('driver_contributor','contributor_hash');
CREATE TRIGGER clean_user_fence BEFORE INSERT OR UPDATE ON public.driver_measurement_revocations FOR EACH ROW EXECUTE FUNCTION sim_clean.fence('driver_contributor','contributor_hash');
COMMIT;
