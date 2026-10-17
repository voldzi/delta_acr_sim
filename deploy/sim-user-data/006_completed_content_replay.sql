-- New explicit content-replay policy, not an alteration of original migration
-- pins or the immutable independent guard. No new role or admin API.
BEGIN;
CREATE POLICY sim_history_request_completed_replay ON public.ai_router_request FOR DELETE TO ai_router_runtime
 USING(client_id='sim' AND EXISTS(SELECT 1 FROM sim_user_history.resource r JOIN sim_user_history.account a USING(owner_key) JOIN sim_user_history.job j USING(owner_key) JOIN sim_user_history.config c ON c.singleton
 WHERE r.kind='sim' AND r.resource_hash=user_hash AND a.state='deleted' AND a.reset_epoch=c.reset_epoch AND j.app_store='deleted' AND j.audit_and_publisher='deleted' AND j.router_sim_history='deleted'));
CREATE POLICY sim_history_billing_completed_replay ON public.ai_router_billing_request FOR DELETE TO ai_router_runtime
 USING(task_type='sim_izs_summary' AND billing_source='sim_project' AND payer_hash='sim_izs_project' AND EXISTS(SELECT 1 FROM sim_user_history.resource r JOIN sim_user_history.account a USING(owner_key) JOIN sim_user_history.job j USING(owner_key) JOIN sim_user_history.config c ON c.singleton
 WHERE r.kind='izs' AND r.resource_hash=actor_hash AND a.state='deleted' AND a.reset_epoch=c.reset_epoch AND j.app_store='deleted' AND j.audit_and_publisher='deleted' AND j.router_sim_history='deleted'));
COMMIT;
