/** Exact post-twelve-component catalog; v1 known-new remains unchanged. */
import { createHash } from "node:crypto";
import { catalog } from "./clean-reset-ops.mjs";
export async function userDataCatalog(c, component) {
  if (!["sim_user_data", "sim_user_history"].includes(component)) throw Error("SIM_USER_PROFILE_COMPONENT");
  const base = component === "sim_user_history" ? (await catalog(c, "ai")).digest : null;
  const row = (
    await c.query(
      `SELECT jsonb_build_object(
 'database',current_database(),
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',r.relname,'kind',r.relkind,'owner',pg_get_userbyid(r.relowner),'acl',r.relacl::text,'rls',r.relrowsecurity,'forceRls',r.relforcerowsecurity,
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid,true) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=r.oid),
 'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid,0,true) ORDER BY pg_get_indexdef(i.indexrelid,0,true)) FROM pg_index i WHERE i.indrelid=r.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled,'function',pg_get_functiondef(t.tgfoid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=r.oid AND NOT t.tgisinternal),
 'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'cmd',p.polcmd,'roles',(SELECT jsonb_agg(pg_get_userbyid(x) ORDER BY pg_get_userbyid(x)) FROM unnest(p.polroles)x),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=r.oid),
 'view',CASE WHEN r.relkind='v' THEN pg_get_viewdef(r.oid,true) ELSE NULL END) ORDER BY r.relname) FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace WHERE(n.nspname=$1 OR(n.nspname='sim_clean' AND r.relname IN('router_usage','billing_usage'))) AND r.relkind IN('r','v')),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'definer',p.prosecdef) ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1)) descriptor`,
      [component]
    )
  ).rows[0].descriptor;
  return {
    baseCatalogDigest: base,
    digest: createHash("sha256")
      .update(JSON.stringify({ base, descriptor: row }))
      .digest("hex")
  };
}
export async function inspectUserDataProfile(c, manifest) {
  const actual = await userDataCatalog(c, "sim_user_history");
  if (
    manifest.contractVersion !== "sim-user-data-reset-profile-v2" ||
    actual.baseCatalogDigest !== manifest.aiPostCatalogDigest ||
    actual.digest !== manifest.aiUserDataCatalogDigest
  )
    throw Error("SIM_USER_DATA_UNKNOWN_CATALOG");
  const remaining = Number(
    (
      await c.query(
        "SELECT(SELECT count(*) FROM public.ai_router_request WHERE client_id='sim')+(SELECT count(*) FROM public.ai_router_billing_request WHERE task_type='sim_izs_summary') n"
      )
    ).rows[0].n
  );
  return {
    contractVersion: manifest.contractVersion,
    state: remaining === 0 ? "known-new-unused" : "known-new-used",
    ...actual,
    remaining,
    wholeAccountComplete: false
  };
}
