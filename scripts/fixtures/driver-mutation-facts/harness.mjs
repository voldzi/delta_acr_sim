/** NEW eight-case tail of a SHA-pinned common bootstrap; no old cases execute.
 * Real common WeakMap contexts, Ed25519/JWS/custody, native/proc SELF, strict TLS,
 * target SQL004/007 and metadata001/002/904214. Host/app observations, enrollment,
 * mutation intents are SYNTHETIC test inputs signed by the actual issuer.
 * No actual COP intent producer, keeper, packet transport or whole ERASE claim.
 */
const MUT_DRIVER='sim_driver_measurements', MUT_AI='sim_ai_router';
const MUT_GROUPS=Object.freeze(['empty-preflight-and-missing-receipt','actual-sql003-first-anchor-denied-existing-anchor-matches',
  'signed-intent-digest-peer-binding-and-shape','actual-context-identity-owner-and-purpose',
  'pending-cleanup-mutation-only-not-ordinary-read','same-metadata-session-tls-known-target-end-no-self-deadlock',
  'intent-and-context-expiry-never-renew-or-auto-unlock','actual-target-disconnect-retains-global-hold']);
const mutOperation={businessOperationId:randomUUID(),operationHash:hash('synthetic mutation business operation'),
  actorHash:hash('synthetic mutation actor'),requestHash:hash('synthetic immutable mutation request'),count:9};
let mutationCommon,mutationResult,mutationFailure;
async function mutSnapshot(){
  const result={};
  for(const [prefix,client,schemaName]of[['metadata',registry,'cop_guard'],['driver',driverAdmin,'public'],['ai',aiAdmin,'public']]){
    const tables=(await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[schemaName])).rows;
    for(const{tablename}of tables){assert.match(tablename,/^[a-z_]+$/);result[prefix+'.'+tablename]=(await client.query(
      'SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\'::jsonb)::text,\'UTF8\')),\'hex\') AS digest FROM '+schemaName+'.'+tablename+' t')).rows[0].digest;}
  }
  return result;
}
async function mutProtected(){
  const o=ids.owners[MUT_DRIVER],paths=[STATE+'/authority/current-frontier.json',STATE+'/owner-policies/'+MUT_DRIVER+'.json',
    STATE+'/clients/'+o.peer.device+'-'+o.peer.inode+'.json',STATE+'/checkpoint-acceptances/'+o.acceptanceId+'.json'];
  return Object.fromEntries(await Promise.all(paths.map(async path=>[path,hash(await readFile(path))])));
}
async function mutLockFree(){
  const r=await registry.query('SELECT pg_try_advisory_lock(hashtext(current_database()),904214) AS held');
  if(r.rows[0].held)assert.equal((await registry.query('SELECT pg_advisory_unlock(hashtext(current_database()),904214) AS released')).rows[0].released,true);
  return r.rows[0].held;
}
async function mutSessions(){return(await registry.query("SELECT a.pid,a.backend_start::text AS started,s.ssl,a.xact_start IS NOT NULL AS in_transaction FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid) WHERE a.datname='cop_account_safety_guard' AND a.usename='cop_guard_root_reader' AND a.application_name='cop-root-owner-authority-v1' ORDER BY a.pid")).rows;}
async function mutTargetSessions(){return(await driverAdmin.query("SELECT pid FROM pg_stat_activity WHERE datname='sim_driver_measurements' AND usename='sim_driver_guard_control' AND application_name='cop-root-owner-authority-v1'")).rows;}
async function mutFresh(owner=MUT_DRIVER,ttl=20000){
  // Explicit fresh SYNTHETIC fixture source before acquiring a new context.
  // The common facts helper never calls this or renews a source.
  await refresh(owner,{ttl});return mutationCommon.requireCurrentOwner(owner,ids.owners[owner].peer,'mutation');
}
async function mutFacts(request){
  await driver.query('BEGIN READ ONLY');
  try{return(await driver.query('SELECT sim_driver_guard_source.read_admission_facts($1::jsonb) AS value',[JSON.stringify(request)])).rows[0].value;}
  finally{await driver.query('ROLLBACK');}
}
async function mutIntent(ctx,{originalAcceptedAt,ttl=5000,overrides={}}={}){
  if(!originalAcceptedAt){const actual=await mutFacts({owner:MUT_DRIVER,scope:'online_driver_scope',purpose:'preflight',
    operationHash:mutOperation.operationHash,actorHash:mutOperation.actorHash});originalAcceptedAt=actual.operation?.createdAtUTC??actual.observedAtUTC;}
  const facts={...Object.fromEntries(['guardStoreId','continuityEpoch','datasetBindingId','runtimeBindingId'].map(k=>[k,ctx[k]])),peer:ctx.peer,
    scopeDigest:hash('synthetic canonical COP HTTP mutation scope'),actionKind:'erase',businessOperationId:mutOperation.businessOperationId,
    operationHash:mutOperation.operationHash,actorHash:mutOperation.actorHash,requestHash:mutOperation.requestHash,contributorCount:mutOperation.count,
    manifestRef:{recordId:randomUUID(),digest:hash('synthetic opaque manifest reference, producer not executed')},
    journalRef:{recordId:randomUUID(),digest:hash('synthetic opaque journal reference, producer not executed')},originalAcceptedAt,...overrides};
  const record=issueRootRecord('cop-driver-mutation-intent',facts,{lifetimeMs:ttl,expectedKeyringDigest:hash(await readFile(ETC+'/public/verification-keys.json'))});
  const path=PRIVATE+'/owner-authority/'+record.payload.recordId+'.json';storeRootRecord(path,record.bytes);
  return{ref:{recordId:record.payload.recordId,digest:record.digest},record,path};
}
function mutInput(ctx,intent,purpose='preflight',overrides={}){return{intentRef:intent.ref,purpose,operationHash:mutOperation.operationHash,
  actorHash:mutOperation.actorHash,requestHash:mutOperation.requestHash,checkpointHash:ctx.rootPolicy.expectedCheckpointHash,...overrides};}
async function mutRead(ctx,intent,purpose='preflight',overrides={}){return mutationCommon.readDriverMutationFacts(ctx,mutInput(ctx,intent,purpose,overrides));}
async function mutCase(name,work){stage='case.'+name;await work();events.push({case:name,passed:true});process.stdout.write('PASS '+name+'\n');}
function mutContributors(acceptedAt){
  const contributors=[],now=Date.parse(acceptedAt),first=Date.parse(new Date(now-8*86400000).toISOString().slice(0,10)),last=Date.parse(new Date(now+30000).toISOString().slice(0,10));
  for(let day=first;day<=last;day+=86400000)contributors.push({contributorDay:new Date(day).toISOString().slice(0,10),contributorHash:hash('synthetic mutation contributor '+day)});
  return contributors;
}
async function mutOriginalSql003(ctx,contributors){
  const body={contractVersion:'sim-driver-guarded-db-v1',operationHash:mutOperation.operationHash,actorHash:mutOperation.actorHash,
    requestHash:mutOperation.requestHash,contributors,checkpointHash:ctx.rootPolicy.expectedCheckpointHash};
  const origin=randomUUID(),permit=randomUUID(),digest=(await driverAdmin.query("SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') AS digest",[JSON.stringify(body)])).rows[0].digest;
  await driver.query('SELECT sim_driver_guard_source.register_origin($1,$2,$3,\'erase\',$4,$5)',[origin,ctx.storeIncarnation,permit,digest,ctx.rootPolicy.schemaFingerprint]);
  // Actual fixed executor session on the fresh private trust-only Unix socket;
  // no SET ROLE/session_user shim, extra grant, Root permit or actual dispatch.
  const{Client}=createRequire(OPT+'/package.json')('pg'),executor=new Client({host:PGROOT+'/socket',port:PORT,database:MUT_DRIVER,user:'sim_driver_guard_exec',password:'',ssl:false,
    connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:3000});executor.on('error',()=>{});clients.add(executor);await executor.connect();
  try{
    await executor.query('BEGIN');const claim=(await executor.query('SELECT pg_current_xact_id()::text AS xid,pg_backend_pid() AS pid,(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS started')).rows[0];
    await driver.query('SELECT sim_driver_guard_source.claim_origin($1,$2,$3::xid8,$4,$5::timestamptz)',[origin,ctx.storeIncarnation,claim.xid,claim.pid,claim.started]);
    const actual=(await executor.query('SELECT sim_driver_guard_source.execute_origin($1,$2::jsonb) AS value',[origin,JSON.stringify(body)])).rows[0].value;
    assert.equal(actual.provisionalInCallerTransaction,true);assert.equal(actual.accountStatus,'pending');await executor.query('COMMIT');
    assert.equal((await driver.query('SELECT sim_driver_guard_source.resolve_or_seal($1) AS value',[origin])).rows[0].value.state,'origin_commit_known');
  }finally{await executor.query('ROLLBACK').catch(()=>{});await executor.end();clients.delete(executor);}
}
async function mutSeedPending(){
  const o=ids.owners[MUT_DRIVER],previous=(await registry.query('SELECT * FROM cop_guard.checkpoint_acceptances WHERE dataset_binding_id=$1 ORDER BY generation DESC LIMIT 1',[o.dataset])).rows[0];
  const original=o.original,receiptId=randomUUID(),acceptanceId=randomUUID();
  await registry.query(`INSERT INTO cop_guard.owner_receipts(receipt_id,replay_operation_id,source_proof_id,source_proof_jws_digest,binding_id,owner_id,
    expected_checkpoint_id,expected_checkpoint_generation,expected_fence_sequence,expected_fence_digest,expected_cleanup_sequence,expected_cleanup_digest,expected_cleanup_status,
    fence_sequence,fence_digest,cleanup_sequence,cleanup_digest,cleanup_status,coverage_evidence_ref,readback_evidence_ref,attempt,observed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,0,$9,'complete',0,$9,0,$9,'pending','synthetic-pending-covered','synthetic-pending-readback',2,clock_timestamp())`,
  [receiptId,original.operationId,original.proofId,original.record.digest,o.runtime,MUT_DRIVER,previous.acceptance_id,previous.generation,ids.frontier]);
  await registry.query(`INSERT INTO cop_guard.checkpoint_acceptances(acceptance_id,dataset_binding_id,generation,previous_acceptance_id,receipt_id,policy_generation,policy_digest,
    protected_config_id,admission_policy_id,continuity_epoch,accepted_frontier_sequence,accepted_frontier_digest,fence_sequence,fence_digest,cleanup_sequence,cleanup_digest,cleanup_status,root_evidence_ref)
    VALUES($1::uuid,$2,$3,$4,$5,1,$6,$7,'synthetic-fixture-v1',$8,0,$9,0,$9,0,$9,'pending',($1::uuid)::text)`,
  [acceptanceId,o.dataset,String(BigInt(previous.generation)+1n),previous.acceptance_id,receiptId,ids.policy,ids.config,ids.epoch,ids.frontier]);
  const digest=async(table,key,id)=>(await registry.query('SELECT encode(sha256(convert_to(to_jsonb(t)::text,\'UTF8\')),\'hex\') AS digest FROM cop_guard.'+table+' t WHERE '+key+'=$1',[id])).rows[0].digest;
  o.acceptanceRef=await signFile(STATE+'/checkpoint-acceptances/'+acceptanceId+'.json','checkpoint-acceptance',{acceptanceId,datasetBindingId:o.dataset,receiptId,
    replayOperationId:original.operationId,sourceProofId:original.proofId,acceptanceDigest:await digest('checkpoint_acceptances','acceptance_id',acceptanceId),
    receiptDigest:await digest('owner_receipts','receipt_id',receiptId),replayDigest:await digest('replay_operations','operation_id',original.operationId)},300000,acceptanceId);
  o.acceptanceId=acceptanceId;o.receiptId=receiptId;
}
async function mutHeldSessionCase(){
  const ctx=await mutFresh(),held=await mutSessions();assert.equal(held.length,1);assert.equal(held[0].ssl,true);assert.equal(held[0].in_transaction,true);
  assert.equal((await mutTargetSessions()).length,0,'Initial target checks must already have completed actual END.');
  const intent=await mutIntent(ctx),before=await mutSnapshot(),files=await mutProtected(),privateNames=(await readdir(PRIVATE+'/owner-authority')).sort();
  try{
    const results=await Promise.all([mutRead(ctx,intent,'preflight'),mutRead(ctx,intent,'receipt')]);
    assert.deepEqual(results[0].operation,results[1].operation);assert.ok(results[1].operation);
    assert.deepEqual(Object.keys(results[1]).sort(),['contractVersion','request','observedAtUTC','storeIncarnation','state','schema','privileges','operation'].sort());
    for(const result of results)for(const key of ['request','state','schema','privileges','operation'])assert.equal(Object.isFrozen(result[key]),true);
    assert.deepEqual(await mutSessions(),held,'Both serial reads must reuse exactly the original held metadata backend.');
    assert.equal((await mutTargetSessions()).length,0,'Both target COMMIT/END operations must complete before facts return.');
    const locks=await registry.query("SELECT mode,granted FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND objid=904214 AND objsubid=2",[held[0].pid]);
    assert.deepEqual(locks.rows,[{mode:'ExclusiveLock',granted:true}]);assert.equal(await mutLockFree(),false);
    assert.deepEqual(await mutSnapshot(),before);assert.deepEqual(await mutProtected(),files);
    assert.deepEqual((await readdir(PRIVATE+'/owner-authority')).sort(),privateNames,'Facts-only reads issue no signed admission or permit.');
  }finally{await ctx.close();}
  assert.equal((await mutSessions()).length,0);assert.equal(await mutLockFree(),true);
}
async function runMutationFacts(){
  const pins=await bootstrap();mutationCommon=await import(OPT+'/root-owner-authority.mjs');
  await mutCase(MUT_GROUPS[0],async()=>{
    const ctx=await mutFresh(),intent=await mutIntent(ctx),before=await mutSnapshot(),files=await mutProtected();
    try{const out=await mutRead(ctx,intent);assert.equal(out.operation,null);assert.equal(Object.isFrozen(out),true);assert.equal(Object.isFrozen(out.request),true);
      assert.equal((await mutRead(ctx,intent,'status')).operation,null);await assert.rejects(mutRead(ctx,intent,'receipt'),{message:'DRIVER_READ_ADMISSION_UNAVAILABLE'});
      assert.deepEqual(await mutSnapshot(),before);assert.deepEqual(await mutProtected(),files);await ctx.assertCurrent();}
    finally{await ctx.close();}assert.equal(await mutLockFree(),true);
  });
  await mutCase(MUT_GROUPS[1],async()=>{
    const ctx=await mutFresh();try{
      const initial=await mutFacts({owner:MUT_DRIVER,scope:'online_driver_scope',purpose:'preflight',operationHash:mutOperation.operationHash,actorHash:mutOperation.actorHash});
      assert.equal(initial.operation,null);const contributors=mutContributors(initial.observedAtUTC);mutOperation.count=contributors.length;
      const intent=await mutIntent(ctx,{originalAcceptedAt:initial.observedAtUTC});await mutRead(ctx,intent);
      await mutOriginalSql003(ctx,contributors);const actual=await mutFacts({owner:MUT_DRIVER,scope:'online_driver_scope',purpose:'receipt',operationHash:mutOperation.operationHash,actorHash:mutOperation.actorHash});
      assert.notEqual(actual.operation.createdAtUTC,intent.record.payload.originalAcceptedAt,'Actual SQL003 samples its own later clock, never the preflight anchor.');
      await assert.rejects(mutRead(ctx,intent,'receipt'),{message:'GUARD_OWNER_MUTATION_ORIGINAL_ANCHOR'});
      const existing=await mutIntent(ctx,{originalAcceptedAt:actual.operation.createdAtUTC});const out=await mutRead(ctx,existing,'receipt');
      assert.deepEqual(out.operation,actual.operation);assert.equal(out.operation.contributorCount,mutOperation.count);
      for(const overrides of[{requestHash:hash('wrong actual request')},{contributorCount:mutOperation.count+1},{originalAcceptedAt:new Date(Date.parse(actual.operation.createdAtUTC)-1).toISOString()}]){
        const bad=await mutIntent(ctx,{overrides});await assert.rejects(mutRead(ctx,bad,'receipt',overrides.requestHash?{requestHash:overrides.requestHash}:{}),{message:'GUARD_OWNER_MUTATION_ORIGINAL_ANCHOR'});
      }
      // A separate fresh existing-ledger fixture input, never a rewrite or
      // lifetime extension of the original empty-preflight intent above.
      await mutRead(ctx,await mutIntent(ctx),'receipt');
    }finally{await ctx.close();}assert.equal(await mutLockFree(),true);
  });
  await mutCase(MUT_GROUPS[2],async()=>{
    const ctx=await mutFresh();try{
      const good=await mutIntent(ctx);await mutRead(ctx,good,'receipt');
      await assert.rejects(mutRead(ctx,good,'receipt',{intentRef:{...good.ref,digest:'0'.repeat(64)}}));
      const original=await readFile(good.path),forged=canonicalJson(original);forged.payload.requestHash=hash('forged mutation request');
      await privateFile(good.path,canonical(forged)+'\n');try{await assert.rejects(mutRead(ctx,good,'receipt'));}finally{await privateFile(good.path,original);}
      for(const overrides of[{peer:{...ctx.peer,inode:String(BigInt(ctx.peer.inode)+1n)}},{datasetBindingId:randomUUID()},{actionKind:'revoke'},{unexpected:true}]){
        const bad=await mutIntent(ctx,{overrides});await assert.rejects(mutRead(ctx,bad,'receipt'),{message:'GUARD_OWNER_MUTATION_INTENT'});
      }
      await assert.rejects(mutationCommon.readDriverMutationFacts(ctx,{...mutInput(ctx,good),extra:true}),{message:'GUARD_OWNER_MUTATION_FACTS_REQUEST'});
      await mutRead(ctx,await mutIntent(ctx),'receipt');
    }finally{await ctx.close();}assert.equal(await mutLockFree(),true);
  });
  await mutCase(MUT_GROUPS[3],async()=>{
    const ctx=await mutFresh(),intent=await mutIntent(ctx);try{await assert.rejects(mutationCommon.readDriverMutationFacts({...ctx},mutInput(ctx,intent)),{message:'GUARD_OWNER_CONTEXT'});}
    finally{await ctx.close();}
    await refresh(MUT_DRIVER);const readCtx=await mutationCommon.requireCurrentOwner(MUT_DRIVER,ids.owners[MUT_DRIVER].peer,'read');
    try{await assert.rejects(mutationCommon.readDriverMutationFacts(readCtx,mutInput(readCtx,intent)),{message:'GUARD_OWNER_MUTATION_PURPOSE'});}finally{await readCtx.close();}
    const aiCtx=await mutFresh(MUT_AI);try{await assert.rejects(mutationCommon.readDriverMutationFacts(aiCtx,mutInput(aiCtx,intent)),{message:'GUARD_OWNER_MUTATION_PURPOSE'});}finally{await aiCtx.close();}
    assert.equal(await mutLockFree(),true);
  });
  await mutCase(MUT_GROUPS[4],async()=>{
    await mutSeedPending();const ctx=await mutFresh(),intent=await mutIntent(ctx);try{const out=await mutRead(ctx,intent,'receipt');assert.ok(out.operation);}
    finally{await ctx.close();}
    assert.equal((await registry.query('SELECT cleanup_status FROM cop_guard.checkpoint_acceptances WHERE acceptance_id=$1',[ids.owners[MUT_DRIVER].acceptanceId])).rows[0].cleanup_status,'pending');
    await assert.rejects(mutationCommon.requireCurrentOwner(MUT_DRIVER,ids.owners[MUT_DRIVER].peer,'read'),{message:'GUARD_OWNER_CHECKPOINT_PENDING'});
    assert.equal(await mutLockFree(),true);
  });
  await mutCase(MUT_GROUPS[5],mutHeldSessionCase);
  await mutCase(MUT_GROUPS[6],async()=>{
    let ctx=await mutFresh();try{
      const intent=await mutIntent(ctx,{ttl:500}),before=await mutSnapshot(),files=await mutProtected(),bytes=await readFile(intent.path);
      await delay(Math.max(1,Date.parse(intent.record.payload.expiresAt)-Date.now()+60));await assert.rejects(mutRead(ctx,intent,'receipt'));
      assert.equal(await mutLockFree(),false);assert.deepEqual(await readFile(intent.path),bytes);assert.deepEqual(await mutSnapshot(),before);assert.deepEqual(await mutProtected(),files);
    }finally{await ctx.close();}assert.equal(await mutLockFree(),true);
    ctx=await mutFresh(MUT_DRIVER,2500);const intent=await mutIntent(ctx),before=await mutSnapshot(),files=await mutProtected();
    try{await delay(Math.max(1,Date.parse(ctx.expiresAtUTC)-Date.now()+80));await assert.rejects(mutRead(ctx,intent,'receipt'));
      assert.equal(await mutLockFree(),false);assert.deepEqual(await mutSnapshot(),before);assert.deepEqual(await mutProtected(),files);
    }finally{await ctx.close();}assert.equal(await mutLockFree(),true);
  });
  await mutCase(MUT_GROUPS[7],async()=>{
    const ctx=await mutFresh(),intent=await mutIntent(ctx),held=await mutSessions();assert.equal(held.length,1);
    const locker=await open(MUT_DRIVER);let pending;
    try{
      await locker.query('BEGIN');await locker.query('LOCK TABLE public.driver_account_erasure_operations IN ACCESS EXCLUSIVE MODE');
      pending=mutRead(ctx,intent,'receipt').then(()=>({ok:true}),error=>({ok:false,message:error.message}));let target;
      const until=Date.now()+900;while(Date.now()<until){target=(await driverAdmin.query("SELECT pid FROM pg_stat_activity WHERE datname='sim_driver_measurements' AND usename='sim_driver_guard_control' AND application_name='cop-root-owner-authority-v1' AND wait_event_type='Lock'")).rows[0];if(target)break;await delay(10);}
      assert.ok(target,'Actual target SQL004 must block before disconnect.');assert.equal((await driverAdmin.query('SELECT pg_terminate_backend($1) AS terminated',[target.pid])).rows[0].terminated,true);
      assert.equal((await pending).ok,false);await assert.rejects(ctx.close(),{message:'GUARD_OWNER_HOLD'});
      await assert.rejects(mutationCommon.requireCurrentOwner(MUT_AI,ids.owners[MUT_AI].peer,'mutation'),{message:'GUARD_OWNER_REQUEST'});
      assert.equal(await mutLockFree(),false);assert.deepEqual(await mutSessions(),held);
    }finally{await locker.query('ROLLBACK');if(pending)await pending;await locker.end();clients.delete(locker);}
  });
  assert.deepEqual(events.map(row=>row.case),MUT_GROUPS);for(const[path,pin]of Object.entries(pins))assert.equal(hash(await readFile(path)),pin);
  return{contractVersion:'sim-driver-mutation-facts-root-v1',passed:events.length,cases:events,startedAt,completedAt:new Date().toISOString(),
    realEd25519:true,realJws:true,realStrictTls:true,realMetadata001:true,realTargetSql004:true,realTargetSql007:true,realPg904214Leases:true,
    actualWeakMapContext:true,actualSql003SyntheticOriginSeed:true,actualRootDispatch:false,actualCopIntentProducerExecuted:false,
    mutationIntentSynthetic:true,mutationScopeProduced:false,dedicatedSignerExercised:false,rootKeeperExercised:false,firstPostAnchorRejected:true,
    hostObservationSynthetic:true,actualHostObserverExecuted:false,appPeerSynthetic:true,actualPidfdSelf:true,singleRootProcess:true,
    nativeTransport:false,providerCalls:0,authorityCallbacks:0,pgStubs:0,actualTargetDisconnectHold:true,unknownTargetEndExercised:false,
    lostCommitExercised:false,sourceRenewedByHelper:false,globalHoldNotReset:true,productionEnrollment:false,productionChanged:false,
    deploymentAccepted:false,restoreAccepted:false,wholeAccountComplete:false};
}
try{assert.deepEqual(process.argv.slice(2),['--run']);mutationResult=await runMutationFacts();}catch(error){mutationFailure=error;}
finally{
  clearInterval(hostTimer);for(const jobs of pendingHostWrites.values())await Promise.allSettled([...jobs]);
  for(const client of clients)await client.end().catch(()=>{});
  // Destruction of this owned fixture, NOT quiescence/restore/HOLD recovery.
  if(started)await pgCommand('pg_ctl',['-D',PGROOT+'/data','-m','immediate','-w','stop']).catch(()=>{});clearTimeout(deadline);
}
if(mutationFailure){
  const message=typeof mutationFailure.message==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(mutationFailure.message)?mutationFailure.message:'FIXTURE_ASSERTION_FAILED';
  const sqlState=typeof mutationFailure.code==='string'&&/^[0-9A-Z]{5}$/.test(mutationFailure.code)?mutationFailure.code:null;
  const site=typeof mutationFailure.stack==='string'?/\/fixture\/harness\.mjs:([0-9]{1,6}):([0-9]{1,4})\b/.exec(mutationFailure.stack):null;
  console.log(JSON.stringify({contractVersion:'sim-driver-mutation-facts-root-v1',passed:false,stage,failure:message,sqlState,failureSite:site?'harness.mjs:'+site[1]+':'+site[2]:null}));process.exitCode=1;
}else console.log(JSON.stringify(mutationResult));
