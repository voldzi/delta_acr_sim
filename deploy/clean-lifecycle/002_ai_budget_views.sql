-- New clean namespace only. Does not replace CF24 views or import old rollups.
BEGIN;
CREATE VIEW sim_clean.router_usage WITH(security_invoker=true) AS
 SELECT user_hash,charged_microusd,reserved_microusd,input_tokens::bigint,output_tokens::bigint,created_at,1::bigint AS record_count FROM public.ai_router_request
 UNION ALL SELECT NULL::text,microusd,microusd,input_tokens,output_tokens,usage_day::timestamp AT TIME ZONE 'UTC',requests FROM sim_clean.cost_daily WHERE lane='router' AND expires_at>now();
CREATE VIEW sim_clean.billing_usage WITH(security_invoker=true) AS
 SELECT billing_source,payer_hash,actor_hash,estimated_microusd,reserved_microusd,input_tokens::bigint,output_tokens::bigint,created_at,1::bigint AS record_count FROM public.ai_router_billing_request
 UNION ALL SELECT 'user_openai_key',NULL::text,NULL::text,microusd,microusd,input_tokens,output_tokens,usage_day::timestamp AT TIME ZONE 'UTC',requests FROM sim_clean.cost_daily WHERE lane='byok' AND expires_at>now();
COMMIT;
