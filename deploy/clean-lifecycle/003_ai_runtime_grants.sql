-- Migration owner, ONLY after explicit clean-empty baseline enrollment.
-- Fixed existing AI runtime role; no DDL, role, network or secret privileges.
BEGIN;
GRANT USAGE ON SCHEMA sim_clean TO ai_router_runtime;
GRANT SELECT ON sim_clean.config,sim_clean.router_usage,sim_clean.billing_usage TO ai_router_runtime;
GRANT SELECT,INSERT,UPDATE ON sim_clean.account,sim_clean.resource,sim_clean.job,sim_clean.cost_daily TO ai_router_runtime;
GRANT DELETE ON sim_clean.cost_daily TO ai_router_runtime;
GRANT EXECUTE ON FUNCTION sim_clean.fence() TO ai_router_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ai_router_request,ai_router_user_key,ai_router_user_key_audit,ai_router_billing_request TO ai_router_runtime;
GRANT SELECT,INSERT,UPDATE ON ai_router_policy TO ai_router_runtime;
GRANT INSERT ON ai_router_policy_audit TO ai_router_runtime;
GRANT USAGE,SELECT ON SEQUENCE ai_router_user_key_audit_id_seq,ai_router_policy_audit_id_seq TO ai_router_runtime;
COMMIT;
