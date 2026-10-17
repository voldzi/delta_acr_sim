// Source candidate, no production imports. The caller must authenticate COP and
// derive ownerKey/resource hashes server-side. Never accept them from a browser.
export class CleanLifecycle {
  constructor(pool, expected) { this.pool = pool; this.expected = expected; }
  async tx(action) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1500ms'");
      const cfg = (await c.query('SELECT * FROM sim_clean.config WHERE singleton')).rows[0];
      const e = this.expected;
      if (!cfg || cfg.contract !== 'cop-sim-user-lifecycle-v1' || cfg.mode !== 'isolated-clean-lifecycle-v1'
          || cfg.reset_epoch !== e.resetEpoch || cfg.environment_id !== e.environmentId || cfg.lane !== e.lane
          ||(e.tokensNotBefore!==undefined&&Number(cfg.tokens_not_before)!==e.tokensNotBefore)) throw new Error('CLEAN_CONFIG_MISMATCH');
      const result = await action(c, cfg);
      await c.query('COMMIT'); return result;
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; }
    finally { c.release(); }
  }
  async reserve(ownerKey, hashes) {
    if (!/^[a-f0-9]{64}$/.test(ownerKey) || !Array.isArray(hashes) || hashes.length > 32
        || hashes.some(h => !/^[a-f0-9]{64}$/.test(h))) throw new Error('INVALID_OWNER_BINDING');
    return this.tx(async (c,cfg) => {
      await c.query('INSERT INTO sim_clean.account(owner_key,reset_epoch) VALUES($1,$2) ON CONFLICT DO NOTHING',[ownerKey,cfg.reset_epoch]);
      const a = (await c.query('SELECT * FROM sim_clean.account WHERE owner_key=$1 FOR UPDATE',[ownerKey])).rows[0];
      if (a.state !== 'active' || a.reset_epoch !== cfg.reset_epoch) throw new Error('CLEAN_ACCOUNT_FENCED');
      for (const hash of hashes) {
        const kind = cfg.lane === 'ai' ? 'ai_hash' : 'driver_contributor';
        await c.query('INSERT INTO sim_clean.resource(kind,resource_hash,owner_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[kind,hash,ownerKey]);
        const r = (await c.query('SELECT owner_key FROM sim_clean.resource WHERE kind=$1 AND resource_hash=$2',[kind,hash])).rows[0];
        if (r.owner_key !== ownerKey) throw new Error('OWNER_BINDING_CONFLICT');
      }
    });
  }
  async assertIntake(c, resourceHash) {
    const cfg=(await c.query('SELECT * FROM sim_clean.config WHERE singleton')).rows[0];
    if(!cfg||cfg.contract!=='cop-sim-user-lifecycle-v1'||cfg.mode!=='isolated-clean-lifecycle-v1'||cfg.environment_id!==this.expected.environmentId||cfg.reset_epoch!==this.expected.resetEpoch||cfg.lane!==this.expected.lane||(this.expected.tokensNotBefore!==undefined&&Number(cfg.tokens_not_before)!==this.expected.tokensNotBefore))throw new Error('CLEAN_CONFIG_MISMATCH');
    if(resourceHash!==undefined){
      const a=(await c.query('SELECT a.state,a.reset_epoch FROM sim_clean.resource r JOIN sim_clean.account a USING(owner_key) WHERE r.kind=$1 AND r.resource_hash=$2 FOR SHARE OF a',[cfg.lane==='ai'?'ai_hash':'driver_contributor',resourceHash])).rows[0];
      if(!a||a.state!=='active'||a.reset_epoch!==cfg.reset_epoch)throw new Error('CLEAN_ACCOUNT_FENCED');
    }
  }
  async request(ownerKey, operationId, requestedAt) {
    return this.tx(async(c,cfg) => {
      // Fresh scope fences even an account which has never used this component.
      // No legacy rows are inferred: unbound writes are rejected by DB triggers.
      await c.query('INSERT INTO sim_clean.account(owner_key,reset_epoch) VALUES($1,$2) ON CONFLICT DO NOTHING',[ownerKey,cfg.reset_epoch]);
      const a = (await c.query('SELECT * FROM sim_clean.account WHERE owner_key=$1 FOR UPDATE',[ownerKey])).rows[0];
      if (!a || a.reset_epoch !== cfg.reset_epoch) throw new Error('UNKNOWN_OWNER');
      const old = (await c.query('SELECT * FROM sim_clean.job WHERE owner_key=$1',[ownerKey])).rows[0];
      if (old) {
        if (old.operation_id !== operationId || old.requested_at.toISOString() !== requestedAt) throw new Error('IMMUTABLE_OPERATION_CONFLICT');
        return {state:a.state};
      }
      if(a.state !== 'active') throw new Error('CLEAN_ACCOUNT_FENCED');
      await c.query('INSERT INTO sim_clean.job(operation_id,owner_key,reset_epoch,requested_at) VALUES($1,$2,$3,$4)',[operationId,ownerKey,cfg.reset_epoch,requestedAt]);
      await c.query("UPDATE sim_clean.account SET state='deletion_pending' WHERE owner_key=$1",[ownerKey]);
      return {state:'deletion_pending'};
    });
  }
  async status(ownerKey, operationId) {
    return this.tx(async c => (await c.query('SELECT a.state FROM sim_clean.account a JOIN sim_clean.job j USING(owner_key) WHERE a.owner_key=$1 AND j.operation_id=$2',[ownerKey,operationId])).rows[0]??null);
  }
  async capability() {
    return this.tx(async(c,cfg)=>{
      const role=(await c.query("SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication AS elevated FROM pg_roles WHERE rolname=current_user")).rows[0];
      if(!role||role.elevated===true||(await c.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS ddl")).rows[0].ddl===true)return false;
      await c.query('SELECT owner_key FROM sim_clean.account LIMIT 0');
      await c.query('SELECT operation_id FROM sim_clean.job LIMIT 0');
      const writes=cfg.lane==='ai'?['ai_router_request','ai_router_user_key','ai_router_user_key_audit','ai_router_billing_request']:['driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta','driver_measurement_revocations'];
      for(const table of writes) {
        const rights=(await c.query("SELECT has_table_privilege(current_user,$1,'SELECT') AND has_table_privilege(current_user,$1,'INSERT') AND has_table_privilege(current_user,$1,'UPDATE') AND has_table_privilege(current_user,$1,'DELETE') AS ok",['public.'+table])).rows[0];
        if(rights.ok!==true)return false;
      }
      for(const table of ['account','resource','job','cost_daily']) {
        const rights=(await c.query("SELECT has_table_privilege(current_user,$1,'SELECT') AND has_table_privilege(current_user,$1,'INSERT') AND has_table_privilege(current_user,$1,'UPDATE') AS ok",['sim_clean.'+table])).rows[0];
        if(rights.ok!==true)return false;
      }
      if((await c.query("SELECT has_table_privilege(current_user,'sim_clean.cost_daily','DELETE') AS ok")).rows[0].ok!==true)return false;
      if(cfg.lane==='ai') { await c.query('SELECT sum(charged_microusd) FROM sim_clean.router_usage');await c.query('SELECT sum(estimated_microusd) FROM sim_clean.billing_usage'); }
      const count=Number((await c.query("SELECT count(*) AS n FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE t.tgname='clean_user_fence' AND n.nspname='sim_clean' AND p.proname='fence' AND t.tgenabled='O'")).rows[0].n);
      return count===(cfg.lane==='ai'?4:3);
    });
  }
  async runOne() {
    return this.tx(async(c,cfg) => {
      // Match lock ordering used by writers and request/reserve: account first.
      const a = (await c.query("SELECT a.* FROM sim_clean.account a JOIN sim_clean.job j USING(owner_key) WHERE a.state='deletion_pending' AND j.completed_at IS NULL AND j.next_attempt_at<=now() ORDER BY j.next_attempt_at LIMIT 1 FOR UPDATE OF a SKIP LOCKED")).rows[0];
      if(!a) return {state:'idle'};
      if(a.reset_epoch !== cfg.reset_epoch) throw new Error('CLEAN_CONFIG_MISMATCH');
      const hashes = (await c.query('SELECT resource_hash FROM sim_clean.resource WHERE owner_key=$1',[a.owner_key])).rows.map(r=>r.resource_hash);
      const outcome = cfg.lane === 'ai' ? await cleanAi(c,hashes) : await cleanDriver(c,hashes);
      if(!outcome) {
        await c.query("UPDATE sim_clean.job SET attempts=attempts+1,last_code='IN_FLIGHT',next_attempt_at=now()+interval '1 second' WHERE owner_key=$1",[a.owner_key]);
        return {state:'deletion_pending'};
      }
      await c.query("UPDATE sim_clean.account SET state='deleted' WHERE owner_key=$1",[a.owner_key]);
      await c.query('UPDATE sim_clean.job SET attempts=attempts+1,last_code=NULL,completed_at=now() WHERE owner_key=$1',[a.owner_key]);
      return {state:'deleted'};
    });
  }
  async purgeExpiredTotals() {
    return this.tx(async c => (await c.query('DELETE FROM sim_clean.cost_daily WHERE expires_at<=now()')).rowCount);
  }
}
async function cleanDriver(c, hashes) {
  await c.query("DELETE FROM public.driver_measurement_receipts WHERE owner='cop' AND contributor_hash::text=ANY($1::text[])",[hashes]);
  await c.query("DELETE FROM public.driver_measurement_revocations WHERE owner='cop' AND contributor_hash::text=ANY($1::text[])",[hashes]);
  const r=(await c.query("SELECT (SELECT count(*) FROM public.driver_measurement_receipts WHERE owner='cop' AND contributor_hash::text=ANY($1::text[]))+(SELECT count(*) FROM public.driver_measurement_eta WHERE owner='cop' AND contributor_hash::text=ANY($1::text[]))+(SELECT count(*) FROM public.driver_measurement_revocations WHERE owner='cop' AND contributor_hash::text=ANY($1::text[])) AS n",[hashes])).rows[0];
  if(Number(r.n)!==0) throw new Error('CLEAN_READBACK_FAILED');
  return true;
}
async function cleanAi(c, hashes) {
  // Revoke stored key immediately, even while a pre-fence reservation settles.
  await c.query('DELETE FROM public.ai_router_user_key WHERE user_hash=ANY($1::text[])',[hashes]);
  const open=(await c.query("SELECT (SELECT count(*) FROM public.ai_router_request WHERE client_id='cop' AND user_hash=ANY($1::text[]) AND status IN ('reserved','uncertain'))+(SELECT count(*) FROM public.ai_router_billing_request WHERE task_type='cop_chat' AND actor_hash=ANY($1::text[]) AND status IN ('reserved','uncertain')) AS n",[hashes])).rows[0];
  if(Number(open.n)>0) return false;
  for(const [lane,table,condition,cost] of [
    ['router','ai_router_request',"client_id='cop' AND user_hash=ANY($1::text[])",'COALESCE(charged_microusd,0)'],
    ['byok','ai_router_billing_request',"task_type='cop_chat' AND actor_hash=ANY($1::text[])",'COALESCE(estimated_microusd,0)']
  ]) await c.query(`INSERT INTO sim_clean.cost_daily(lane,usage_day,microusd,requests,input_tokens,output_tokens,expires_at)
    SELECT '${lane}',(created_at AT TIME ZONE 'UTC')::date,sum(${cost}),count(*),sum(COALESCE(input_tokens,0)),sum(COALESCE(output_tokens,0)),(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC'
    FROM public.${table} WHERE ${condition} AND created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' GROUP BY 2
    ON CONFLICT(lane,usage_day) DO UPDATE SET microusd=sim_clean.cost_daily.microusd+excluded.microusd,requests=sim_clean.cost_daily.requests+excluded.requests,input_tokens=sim_clean.cost_daily.input_tokens+excluded.input_tokens,output_tokens=sim_clean.cost_daily.output_tokens+excluded.output_tokens`,[hashes]);
  await c.query("DELETE FROM public.ai_router_request WHERE client_id='cop' AND user_hash=ANY($1::text[])",[hashes]);
  await c.query("DELETE FROM public.ai_router_billing_request WHERE task_type='cop_chat' AND actor_hash=ANY($1::text[])",[hashes]);
  await c.query('DELETE FROM public.ai_router_user_key_audit WHERE user_hash=ANY($1::text[])',[hashes]);
  const r=(await c.query("SELECT (SELECT count(*) FROM public.ai_router_request WHERE client_id='cop' AND user_hash=ANY($1::text[]))+(SELECT count(*) FROM public.ai_router_billing_request WHERE task_type='cop_chat' AND actor_hash=ANY($1::text[]))+(SELECT count(*) FROM public.ai_router_user_key WHERE user_hash=ANY($1::text[]))+(SELECT count(*) FROM public.ai_router_user_key_audit WHERE user_hash=ANY($1::text[])) AS n",[hashes])).rows[0];
  if(Number(r.n)!==0) throw new Error('CLEAN_READBACK_FAILED');
  return true;
}
export async function installFence(c,lane) {
  // Migration-only; table and column identifiers are a closed static list.
  const specs=lane==='ai' ? [['ai_router_request','user_hash'],['ai_router_user_key','user_hash'],['ai_router_user_key_audit','user_hash'],['ai_router_billing_request','actor_hash']] : [['driver_measurement_receipts','contributor_hash'],['driver_measurement_eta','contributor_hash'],['driver_measurement_revocations','contributor_hash']];
  if(!['ai','driver'].includes(lane)) throw new Error('INVALID_LANE');
  for(const [table,column] of specs) await c.query(`CREATE TRIGGER clean_user_fence BEFORE INSERT OR UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION sim_clean.fence('${lane==='ai'?'ai_hash':'driver_contributor'}','${column}')`);
}
