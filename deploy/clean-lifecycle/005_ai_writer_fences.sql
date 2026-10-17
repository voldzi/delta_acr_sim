-- Owner-only, NEW clean dataset. Does not drop/replace any historical guard.
BEGIN;
CREATE TRIGGER clean_user_fence BEFORE INSERT OR UPDATE ON public.ai_router_request FOR EACH ROW EXECUTE FUNCTION sim_clean.fence('ai_hash','user_hash');
CREATE TRIGGER clean_user_fence BEFORE INSERT OR UPDATE ON public.ai_router_user_key FOR EACH ROW EXECUTE FUNCTION sim_clean.fence('ai_hash','user_hash');
CREATE TRIGGER clean_user_fence BEFORE INSERT OR UPDATE ON public.ai_router_user_key_audit FOR EACH ROW EXECUTE FUNCTION sim_clean.fence('ai_hash','user_hash');
CREATE TRIGGER clean_user_fence BEFORE INSERT OR UPDATE ON public.ai_router_billing_request FOR EACH ROW EXECUTE FUNCTION sim_clean.fence('ai_hash','actor_hash');
COMMIT;
