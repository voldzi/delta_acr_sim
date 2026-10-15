/** Appended only to a SHA-pinned existing bootstrap; none of its old cases run.
 * Actual Root common/SQL004, JWS, TLS, metadata lease and native SELF. Host and
 * app observation/enrollment inputs remain SYNTHETIC. No native transport,
 * lost COMMIT/END, installer, restore, or production acceptance is claimed.
 */
const DRIVER='sim_driver_measurements', AI='sim_ai_router';
const metadataTables=['guard_identity','policies','fence_journal','dataset_bindings','runtime_bindings','accepted_runtime_proofs','replay_operations','owner_receipts','checkpoint_acceptances'];
const driverTables=['driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta','driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations'];
const aiTables=['ai_router_user_key','ai_router_request','ai_router_billing_request','ai_router_user_key_audit','ai_router_account_erasure','ai_router_erasure_checkpoint','ai_router_erased_cost_daily','ai_router_policy','ai_router_policy_audit'];
const copyValue=value=>JSON.parse(canonical(value));
const publicContextData=ctx=>copyValue(Object.fromEntries(Object.entries(ctx).filter(([,value])=>typeof value!=='function')));
async function sourceSnapshot(){
  const result={};
  for(const [prefix,client,schema,tables]of [['registry',registry,'cop_guard',metadataTables],['driver',driverAdmin,'public',driverTables],['ai',aiAdmin,'public',aiTables]]){
    for(const table of tables){
      const r=await client.query('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\'::jsonb) AS value FROM '+schema+'.'+table+' t');
      result[prefix+'.'+table]=hash(canonical(r.rows[0].value));
    }
  }
  for(const view of ['ai_router_budget_usage','ai_router_billing_usage']){
    const r=await aiAdmin.query('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\'::jsonb) AS value FROM public.'+view+' t');
    result['ai.'+view]=hash(canonical(r.rows[0].value));
  }
  return result;
}
async function sourceLockFree(){
  const r=await registry.query('SELECT pg_try_advisory_lock(hashtext(current_database()),904214) AS held');
  if(r.rows[0].held)assert.equal((await registry.query('SELECT pg_advisory_unlock(hashtext(current_database()),904214) AS released')).rows[0].released,true);
  return r.rows[0].held;
}
async function proofRows(owner){return(await registry.query('SELECT * FROM cop_guard.accepted_runtime_proofs WHERE binding_id=$1 ORDER BY accepted_at,issued_at,proof_id',[ids.owners[owner].runtime])).rows;}
async function protectedFiles(){
  const paths=[STATE+'/authority/current-frontier.json'];
  for(const owner of Object.keys(specs)){
    const o=ids.owners[owner];paths.push(STATE+'/'+specs[owner].directory+'/'+o.peer.device+'-'+o.peer.inode+'.json',STATE+'/owner-policies/'+owner+'.json',STATE+'/checkpoint-acceptances/'+o.acceptanceId+'.json');
  }
  return Object.fromEntries(await Promise.all(paths.map(async path=>[path,hash(await readFile(path))])));
}
async function refreshArtifacts(){
  const out={};for(const name of ['runtime-proofs','source-refresh-intents','source-refresh-dispatches'])out[name]=(await readdir(STATE+'/'+name)).sort();return out;
}
async function sourceCase(name,work){stage=name;await work();events.push({case:name,passed:true});process.stdout.write('PASS '+name+'\n');}
async function ordinaryContext(common,owner){return common.requireCurrentOwner(owner,ids.owners[owner].peer,owner===DRIVER?'retention':'checkpoint-read');}
async function exerciseActualRefresh(common,owner){
  const o=ids.owners[owner],other=owner===DRIVER?AI:DRIVER,old=await ordinaryContext(common,owner);
  const oldCopy=publicContextData(old),oldProof=old.sourceProofId;
  assert.ok(Object.isFrozen(old)&&Object.isFrozen(old.rootPolicy));await old.close();
  const before=await sourceSnapshot(),files=await protectedFiles(),rows=await proofRows(owner),otherRows=await proofRows(other);
  const result=await common.refreshRootOwnerSource(owner,o.peer);
  assert.equal(result.status,'refresh-readback-known');assert.equal(result.commitAcknowledged,true);assert.ok(Object.isFrozen(result));
  assert.equal(result.owner,owner);assert.equal(result.priorProofRef.recordId,oldProof);assert.notEqual(result.proposedProofRef.recordId,oldProof);
  assert.deepEqual(publicContextData(old),oldCopy,'The already-closed old public ctx is not upgraded by refresh.');
  await assert.rejects(old.assertCurrent(),{message:'GUARD_OWNER_HOLD'});
  const nextRows=await proofRows(owner);assert.equal(nextRows.length,rows.length+1);assert.deepEqual(await proofRows(other),otherRows);
  const inserted=nextRows.find(row=>row.proof_id===result.proposedProofRef.recordId);assert.ok(inserted);
  assert.equal(inserted.operation_id,result.operationId);assert.equal(inserted.operation_kind,'refresh');assert.equal(inserted.binding_id,o.runtime);
  const {verifyRootJws}=await import(OPT+'/root-jws.mjs'),keys=canonicalJson(await readFile(ETC+'/public/verification-keys.json'));
  const proof=verifyRootJws(await readFile(STATE+'/runtime-proofs/'+inserted.proof_id+'.jws'),keys,'runtime-proof');
  assert.equal(proof.digest,result.proposedProofRef.digest);assert.equal(proof.digest,inserted.proof_jws_digest);
  assert.equal(proof.payload.operationId,result.operationId);assert.equal(proof.payload.operationKind,'refresh');
  assert.equal(proof.payload.recordId,inserted.proof_id);assert.deepEqual(proof.payload.binding,binding(owner));
  assert.deepEqual(proof.payload.ownerPolicyRef,o.policyRef);assert.deepEqual(proof.payload.checkpointAcceptanceRef,o.acceptanceRef);
  assert.ok(Date.parse(proof.payload.expiresAt)-Date.parse(proof.payload.observation.observedAtUTC)<=30000);
  const intent=verifyRootRecord(await readFile(STATE+'/source-refresh-intents/'+result.operationId+'.json'),keys,'source-refresh-intent');
  const dispatch=verifyRootRecord(await readFile(STATE+'/source-refresh-dispatches/'+result.operationId+'.json'),keys,'source-refresh-dispatch');
  assert.equal(intent.payload.operationId,result.operationId);assert.equal(dispatch.payload.operationId,result.operationId);
  assert.deepEqual(intent.payload.priorProofRef,result.priorProofRef);assert.deepEqual(intent.payload.proposedProofRef,result.proposedProofRef);
  assert.deepEqual(dispatch.payload.intentRef,{recordId:result.operationId,digest:intent.digest});
  assert.equal(intent.payload.bodyDigest,hash(canonical(intent.payload.originalBody)));assert.equal(dispatch.payload.bodyDigest,intent.payload.bodyDigest);
  assert.equal(intent.payload.originalBody.refresh.proofId,inserted.proof_id);
  const after=await sourceSnapshot();delete before['registry.accepted_runtime_proofs'];delete after['registry.accepted_runtime_proofs'];
  assert.deepEqual(after,before,'No target/checkpoint/receipt/policy/finance mutation accompanies a source refresh.');
  assert.deepEqual(await protectedFiles(),files,'The helper does not renew anchor, registrations, owner policy or CP acceptance.');
  assert.equal(await sourceLockFree(),true,'Known END must release the actual exclusive metadata session.');
  const current=await ordinaryContext(common,owner);
  try{assert.equal(current.sourceProofId,inserted.proof_id);assert.deepEqual(current.rootPolicy.reference,o.policyRef);await current.assertCurrent();}
  finally{await current.close();}
  assert.equal(await sourceLockFree(),true);return result;
}
async function runSourceRefresh(){
  const pins=await bootstrap(),common=await import(OPT+'/root-owner-authority.mjs');
  // Synthetic nonzero financial fixtures make preservation observable in both
  // actual budget views; they do not mint source authority or change policy.
  await aiAdmin.query("INSERT INTO ai_router_erased_cost_daily(billing_lane,usage_day,cost_microusd,request_count,input_tokens,output_tokens,expires_at) SELECT lane,(clock_timestamp() AT TIME ZONE 'UTC')::date,100,2,17,9,(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC' FROM (VALUES('legacy'),('user_openai_key')) AS x(lane)");
  await sourceCase('fixed refresher profile uses real TLS, default RO and narrow actual SQL004 privileges',async()=>{
    const c=await open('cop_account_safety_guard','cop_guard_source_refresher',passwords.refresher);
    try{
      const actual=(await c.query("SELECT current_user AS role,current_setting('default_transaction_read_only') AS ro,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl")).rows[0];
      assert.deepEqual(actual,{role:'cop_guard_source_refresher',ro:'on',ssl:true});
      const surface=(await c.query("SELECT bool_and(NOT has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AND NOT has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES')) AS narrow FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cop_guard' AND c.relkind='r'")).rows[0];
      assert.equal(surface.narrow,true);assert.equal((await c.query("SELECT has_function_privilege(current_user,'cop_guard.refresh_runtime_proof(jsonb)','EXECUTE') AS allowed")).rows[0].allowed,true);
      const before=await proofRows(DRIVER),ctx=await common.requireCurrentOwner(DRIVER,ids.owners[DRIVER].peer,'source-refresh');
      try{assert.equal(ctx.purpose,'source-refresh');await ctx.assertCurrent();}finally{await ctx.close();}
      assert.deepEqual(await proofRows(DRIVER),before);
      for(const name of ['source-refresh-intents','source-refresh-dispatches']){const s=await lstat(STATE+'/'+name);assert.equal(s.uid,0);assert.equal(s.mode&0o777,0o700);assert.deepEqual(await readdir(STATE+'/'+name),[]);}
    }finally{await c.end();clients.delete(c);}
  });
  await sourceCase('Driver actual one-row refresh preserves old closed ctx and opens a fresh ordinary context',()=>exerciseActualRefresh(common,DRIVER));
  await sourceCase('AI actual one-row refresh isolates the other owner and preserves financial data',()=>exerciseActualRefresh(common,AI));
  await sourceCase('pre-claim custody failure cannot insert a proof or poison a known closed lease',async()=>{
    const path=STATE+'/source-refresh-dispatches',before=await sourceSnapshot(),artifacts=await refreshArtifacts();
    try{await chmod(path,0o755);await assert.rejects(common.refreshRootOwnerSource(DRIVER,ids.owners[DRIVER].peer),{message:'GUARD_PARENT_CUSTODY'});}
    finally{await chmod(path,0o700);}
    assert.deepEqual(await sourceSnapshot(),before);assert.deepEqual(await refreshArtifacts(),artifacts);assert.equal(await sourceLockFree(),true);
    const ctx=await ordinaryContext(common,DRIVER);try{await ctx.assertCurrent();}finally{await ctx.close();}
  });
  await sourceCase('expired original proof is denied despite independently fresh synthetic host and anchor inputs',async()=>{
    const rows=await proofRows(DRIVER),last=rows.at(-1);assert.ok(last);
    await delay(Math.max(0,new Date(last.valid_until).getTime()-Date.now()+30));
    // Deliberate fixture input only: isolate old SOURCE expiry from anchor
    // expiry. This is not performed by the Root helper and is not a PASS claim
    // for a production host/anchor observer or automatic recovery.
    await frontier();await hostFact(DRIVER);
    const before=await sourceSnapshot(),artifacts=await refreshArtifacts();
    await assert.rejects(common.refreshRootOwnerSource(DRIVER,ids.owners[DRIVER].peer),{message:'GUARD_OWNER_REGISTRY'});
    assert.deepEqual(await sourceSnapshot(),before);assert.deepEqual(await refreshArtifacts(),artifacts);assert.equal(await sourceLockFree(),true);
  });
  await sourceCase('explicit actual common HOLD denies new refresh and keeps the real metadata barrier',async()=>{
    // Explicit synthetic source input, not a recovery performed by common.
    await refresh(DRIVER,{ttl:29900});
    const ctx=await ordinaryContext(common,DRIVER),before=await sourceSnapshot(),artifacts=await refreshArtifacts();
    common.holdOwnerLease(ctx);
    await assert.rejects(common.refreshRootOwnerSource(DRIVER,ids.owners[DRIVER].peer),{message:'GUARD_OWNER_REQUEST'});
    await assert.rejects(ctx.close(),{message:'GUARD_OWNER_HOLD'});
    assert.deepEqual(await sourceSnapshot(),before);assert.deepEqual(await refreshArtifacts(),artifacts);assert.equal(await sourceLockFree(),false);
  });
  for(const[path,pin]of Object.entries(pins))assert.equal(hash(await readFile(path)),pin);
  return {contractVersion:'sim-root-source-refresh-isolated-linux-v1',passed:events.length,cases:events,startedAt,completedAt:new Date().toISOString(),
    actualSourceRefresh:true,realEd25519:true,realJws:true,realStrictTls:true,realMetadata001:true,realSourceRefreshSql004:true,realPg904214Leases:true,
    syntheticAcceptedMetadata:true,hostObservationSynthetic:true,appPeerSynthetic:true,actualHostObserverExecuted:false,actualPidfdSelf:true,singleRootProcess:true,
    nativeTransport:false,providerCalls:0,pgStubs:0,authorityCallbacks:0,lostCommitExercised:false,unknownTargetEndExercised:false,globalHoldNotReset:true,
    oldPublicContextCoverage:'previously-closed-immutable-reference-only-not-private-internal-ctx-hook',checkpointOrAnchorRenewalByHelper:false,
    productionEnrollment:false,productionChanged:false,hostDeploymentAccepted:false,wholeAccountComplete:false,restoreAccepted:false};
}
let sourceResult,sourceFailure;
try{assert.deepEqual(process.argv.slice(2),['--run']);sourceResult=await runSourceRefresh();}
catch(error){sourceFailure=error;}
finally{
  clearInterval(hostTimer);for(const jobs of pendingHostWrites.values())await Promise.allSettled([...jobs]);
  for(const client of clients)await client.end().catch(()=>{});
  // Container-owned fixture teardown only; never production HOLD recovery.
  if(started)await pgCommand('pg_ctl',['-D',PGROOT+'/data','-m','immediate','-w','stop']).catch(()=>{});clearTimeout(deadline);
}
if(sourceFailure){
  const sqlState=typeof sourceFailure.code==='string'&&/^[0-9A-Z]{5}$/.test(sourceFailure.code)?sourceFailure.code:null;
  const boundedPosition=value=>typeof value==='string'&&/^[1-9][0-9]{0,7}$/.test(value)&&Number(value)<=10000000?Number(value):null;
  const sourcePosition=boundedPosition(sourceFailure.position),internalPosition=boundedPosition(sourceFailure.internalPosition);
  const message=typeof sourceFailure.message==='string'&&(/^GUARD_[A-Z0-9_]+$/.test(sourceFailure.message)||
    sqlState!==null&&/^[a-z][a-z0-9_]{0,127}$/.test(sourceFailure.message)||
    sqlState==='42601'&&/^syntax error at or near "[A-Za-z_]+"$/.test(sourceFailure.message))?sourceFailure.message:'FIXTURE_ASSERTION_FAILED';
  const site=typeof sourceFailure.stack==='string'?/\/fixture\/harness\.mjs:([0-9]{1,6}):([0-9]{1,4})\b/.exec(sourceFailure.stack):null;
  // Only fixed token-shaped SQL exception messages and SQLSTATE may leave this
  // private fixture; never detail, hint, query, parameter values, or raw stack.
  console.log(JSON.stringify({contractVersion:'sim-root-source-refresh-isolated-linux-v1',passed:false,stage,failure:message,sqlState,sourcePosition,internalPosition,failureSite:site?'harness.mjs:'+site[1]+':'+site[2]:null}));
  process.exitCode=1;
}else console.log(JSON.stringify(sourceResult));
