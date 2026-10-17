-- ONLY inside the reviewed Root atomic reset after exact old-manifest match.
-- All writer tables remain ACCESS EXCLUSIVE locked until new fences commit.
DROP TRIGGER ai_router_key_erasure_fence ON public.ai_router_user_key;
DROP TRIGGER ai_router_request_erasure_fence ON public.ai_router_request;
DROP TRIGGER ai_router_billing_erasure_fence ON public.ai_router_billing_request;
DROP POLICY router_request_erasure_delete ON public.ai_router_request;
DROP POLICY router_billing_erasure_delete ON public.ai_router_billing_request;
DROP POLICY router_key_audit_erasure_delete ON public.ai_router_user_key_audit;
CREATE POLICY clean_request_delete ON public.ai_router_request FOR DELETE TO ai_router_runtime
 USING(client_id='cop' AND EXISTS(SELECT 1 FROM sim_clean.resource r JOIN sim_clean.account a USING(owner_key) JOIN sim_clean.config c ON c.singleton
 WHERE r.kind='ai_hash' AND r.resource_hash=user_hash AND a.state='deletion_pending' AND a.reset_epoch=c.reset_epoch));
CREATE POLICY clean_billing_delete ON public.ai_router_billing_request FOR DELETE TO ai_router_runtime
 USING(task_type='cop_chat' AND billing_source='user_openai_key' AND actor_hash=payer_hash AND EXISTS(SELECT 1 FROM sim_clean.resource r JOIN sim_clean.account a USING(owner_key) JOIN sim_clean.config c ON c.singleton
 WHERE r.kind='ai_hash' AND r.resource_hash=actor_hash AND a.state='deletion_pending' AND a.reset_epoch=c.reset_epoch));
CREATE POLICY clean_key_audit_delete ON public.ai_router_user_key_audit FOR DELETE TO ai_router_runtime
 USING(EXISTS(SELECT 1 FROM sim_clean.resource r JOIN sim_clean.account a USING(owner_key) JOIN sim_clean.config c ON c.singleton
 WHERE r.kind='ai_hash' AND r.resource_hash=user_hash AND a.state='deletion_pending' AND a.reset_epoch=c.reset_epoch));
