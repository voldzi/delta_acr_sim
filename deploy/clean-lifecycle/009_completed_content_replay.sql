-- Source candidate only. Install by the migration owner with writers stopped.
-- Never changes CF24, acceptance, jobs, identity, epoch, or INSERT/UPDATE fences.
BEGIN;
CREATE POLICY clean_request_completed_replay ON public.ai_router_request FOR DELETE TO ai_router_runtime
 USING(client_id='cop' AND EXISTS(SELECT 1 FROM sim_clean.resource r JOIN sim_clean.account a USING(owner_key) JOIN sim_clean.job j USING(owner_key) JOIN sim_clean.config c ON c.singleton
 WHERE r.kind='ai_hash' AND r.resource_hash=user_hash AND a.state='deleted' AND j.completed_at IS NOT NULL AND a.reset_epoch=c.reset_epoch AND j.reset_epoch=a.reset_epoch));
CREATE POLICY clean_billing_completed_replay ON public.ai_router_billing_request FOR DELETE TO ai_router_runtime
 USING(task_type='cop_chat' AND billing_source='user_openai_key' AND actor_hash=payer_hash AND EXISTS(SELECT 1 FROM sim_clean.resource r JOIN sim_clean.account a USING(owner_key) JOIN sim_clean.job j USING(owner_key) JOIN sim_clean.config c ON c.singleton
 WHERE r.kind='ai_hash' AND r.resource_hash=actor_hash AND a.state='deleted' AND j.completed_at IS NOT NULL AND a.reset_epoch=c.reset_epoch AND j.reset_epoch=a.reset_epoch));
CREATE POLICY clean_key_audit_completed_replay ON public.ai_router_user_key_audit FOR DELETE TO ai_router_runtime
 USING(EXISTS(SELECT 1 FROM sim_clean.resource r JOIN sim_clean.account a USING(owner_key) JOIN sim_clean.job j USING(owner_key) JOIN sim_clean.config c ON c.singleton
 WHERE r.kind='ai_hash' AND r.resource_hash=user_hash AND a.state='deleted' AND j.completed_at IS NOT NULL AND a.reset_epoch=c.reset_epoch AND j.reset_epoch=a.reset_epoch));
COMMIT;
