/** Nine NEW actual dedicated signer groups. The generated prefix contains only
 * frozen common22 bootstrap + facts8 helpers, never either old suite's cases.
 * Intent/scope/enrollment/host/app inputs are SYNTHETIC, actual Root signatures,
 * WeakMap contexts, native SELF, PG/SQL/TLS/leases/END are real. No COP producer,
 * keeper/native packet/HTTP acceptance, production or whole ERASE acceptance.
 */
const MUT_DRIVER='sim_driver_measurements',MUT_AI='sim_ai_router';
const AD_GROUPS=Object.freeze(['missing-preflight-null-digest-receipt-denied','actual-first-post-anchor-denied-existing-ledger-v2-exact',
  'actual-context-copy-owner-and-purpose-denied','pending-cleanup-signs-mutation-not-ordinary-read','scope-reference-shape-and-all-binding-negatives',
  'signed-admission-bounded-by-all-current-deadlines','expired-scope-intent-and-context-never-renew','same-metadata-backend-target-tls-known-end-no-dml',
  'actual-target-disconnect-hold-denies-admission']);
const AD_BASE=['contractVersion','kind','recordId','issuedAt','expiresAt'];
const AD_FIELDS=['request','requestDigest','guardStoreId','continuityEpoch','datasetBindingId','runtimeBindingId','sourceProofId','policyGeneration',
  'frontierSequence','frontierDigest','storeIncarnation','checkpointHash','reportProtection','schemaFingerprint','privilegeFingerprint','factsDigest',
  'operationDigest','peer','clientRegistrationRef','authorityRef','mutationScopeRef','intentRef','requestHash'];
let adRequestDigest,adResult,adFailure;
const adRequest=(ctx,purpose)=>({owner:MUT_DRIVER,scope:'online_driver_scope',purpose,operationHash:mutOperation.operationHash,actorHash:mutOperation.actorHash});
async function adScope(ctx,intent,{ttl,overrides={}}={}){
  const facts={scopeId:randomUUID(),requestDigest:intent.record.payload.scopeDigest,peer:ctx.peer,owner:MUT_DRIVER,scope:'online_driver_scope',actionKind:'erase',
    intentRef:intent.ref,authorityRef:ctx.reference,...Object.fromEntries(['guardStoreId','continuityEpoch','datasetBindingId','runtimeBindingId','sourceProofId',
      'storeIncarnation','frontierSequence','frontierDigest'].map(k=>[k,ctx[k]])),...overrides};
  const lifetime=ttl??Math.min(5000,Date.parse(intent.record.payload.expiresAt)-Date.now()-100,Date.parse(ctx.expiresAtUTC)-Date.now()-100);
  assert.ok(Number.isSafeInteger(lifetime)&&lifetime>0);
  const record=issueRootRecord('driver-mutation-scope',facts,{lifetimeMs:lifetime,expectedKeyringDigest:hash(await readFile(ETC+'/public/verification-keys.json'))});
  const path=PRIVATE+'/mutation-scopes/'+record.payload.recordId+'.json';storeRootRecord(path,record.bytes);
  return{ref:{recordId:record.payload.recordId,digest:record.digest},record,path};
}
async function adPair(ctx,{intentOptions,scopeOptions}={}){const intent=await mutIntent(ctx,intentOptions);return{intent,scope:await adScope(ctx,intent,scopeOptions)};}
const adInput=(ctx,pair,purpose='receipt',overrides={})=>({mutationScopeRef:pair.scope.ref,...mutInput(ctx,pair.intent,purpose),...overrides});
const adCall=(ctx,pair,purpose='receipt',overrides={})=>mutationCommon.inspectDriverMutationAdmission(ctx,adInput(ctx,pair,purpose,overrides));
async function adCheck(ctx,pair,purpose,out){
  assert.deepEqual(Object.keys(out).sort(),['admission','record']);assert.equal(typeof out.record,'string');assert.equal(Object.isFrozen(out),true);
  const request=adRequest(ctx,purpose),keys=canonicalJson(await readFile(ETC+'/public/verification-keys.json'));
  const verified=verifyRootRecord(Buffer.from(out.record),keys,'driver-mutation-read-admission'),p=verified.payload;
  assert.deepEqual(Object.keys(p).sort(),[...AD_BASE,...AD_FIELDS].sort());
  assert.deepEqual(out.admission,{contractVersion:'sim-driver-mutation-read-admission-v2',...request,checkpointHash:ctx.rootPolicy.expectedCheckpointHash,
    reportProtection:ctx.rootPolicy.reportProtection,mutationScopeRef:pair.scope.ref,reference:{recordId:p.recordId,digest:verified.digest}});
  assert.equal(Object.isFrozen(out.admission),true);assert.equal(Object.isFrozen(out.admission.reference),true);
  assert.deepEqual(p.request,request);assert.equal(p.requestDigest,adRequestDigest(request));
  for(const key of ['guardStoreId','continuityEpoch','datasetBindingId','runtimeBindingId','sourceProofId','policyGeneration','frontierSequence','frontierDigest','storeIncarnation'])assert.equal(p[key],ctx[key]);
  assert.equal(p.checkpointHash,ctx.rootPolicy.expectedCheckpointHash);assert.equal(p.reportProtection,ctx.rootPolicy.reportProtection);
  assert.equal(p.schemaFingerprint,ctx.rootPolicy.schemaFingerprint);assert.equal(p.privilegeFingerprint,ctx.rootPolicy.privilegeFingerprint);
  assert.deepEqual(p.peer,ctx.peer);assert.deepEqual(p.authorityRef,ctx.reference);assert.deepEqual(p.mutationScopeRef,pair.scope.ref);assert.deepEqual(p.intentRef,pair.intent.ref);
  assert.equal(p.requestHash,mutOperation.requestHash);assert.match(p.factsDigest,/^[0-9a-f]{64}$/);
  const registration=await readFile(STATE+'/clients/'+ctx.peer.device+'-'+ctx.peer.inode+'.json');
  assert.deepEqual(p.clientRegistrationRef,{recordId:ctx.registration.recordId,digest:hash(registration)});
  const actual=await mutFacts(request);assert.equal(p.operationDigest,actual.operation?.ledgerDigest??null);
  const expiry=Date.parse(p.expiresAt),issued=Date.parse(p.issuedAt);
  assert.ok(issued<=Date.now()&&expiry>Date.now()&&expiry-issued>0&&expiry-issued<=5000);
  for(const ceiling of [ctx.expiresAtUTC,pair.intent.record.payload.expiresAt,pair.scope.record.payload.expiresAt,actual.state.proofValidUntilUTC])assert.ok(expiry<=Date.parse(ceiling));
  return p;
}
async function runAdmission(){
  const pins=await bootstrap();mutationCommon=await import(OPT+'/root-owner-authority.mjs');
  ({driverReadRequestDigest:adRequestDigest}=await import(OPT+'/read-admission-facts.mjs'));
  await mutCase(AD_GROUPS[0],async()=>{
    const ctx=await mutFresh();try{
      const pair=await adPair(ctx),out=await adCall(ctx,pair,'preflight'),p=await adCheck(ctx,pair,'preflight',out);assert.equal(p.operationDigest,null);
      await adCheck(ctx,pair,'status',await adCall(ctx,pair,'status'));await assert.rejects(adCall(ctx,pair,'receipt'),{message:'DRIVER_READ_ADMISSION_UNAVAILABLE'});
    }finally{await ctx.close();}assert.equal(await mutLockFree(),true);
  });
  await mutCase(AD_GROUPS[1],async()=>{
    const ctx=await mutFresh();try{
      const initial=await mutFacts(adRequest(ctx,'preflight'));assert.equal(initial.operation,null);
      const contributors=mutContributors(initial.observedAtUTC);mutOperation.count=contributors.length;
      const oldIntent=await mutIntent(ctx,{originalAcceptedAt:initial.observedAtUTC}),beforePair={intent:oldIntent,scope:await adScope(ctx,oldIntent)};
      await adCheck(ctx,beforePair,'preflight',await adCall(ctx,beforePair,'preflight'));await mutOriginalSql003(ctx,contributors);
      const actual=await mutFacts(adRequest(ctx,'receipt'));assert.notEqual(actual.operation.createdAtUTC,oldIntent.record.payload.originalAcceptedAt);
      const postPair={intent:oldIntent,scope:await adScope(ctx,oldIntent)};
      await assert.rejects(adCall(ctx,postPair,'receipt'),{message:'GUARD_OWNER_MUTATION_ORIGINAL_ANCHOR'});
      const pair=await adPair(ctx);const out=await adCall(ctx,pair),p=await adCheck(ctx,pair,'receipt',out);
      assert.equal(p.operationDigest,actual.operation.ledgerDigest);assert.equal(p.requestHash,actual.operation.requestHash);
      assert.equal(pair.intent.record.payload.originalAcceptedAt,actual.operation.createdAtUTC);
    }finally{await ctx.close();}assert.equal(await mutLockFree(),true);
  });
  await mutCase(AD_GROUPS[2],async()=>{
    let ctx=await mutFresh(),pair=await adPair(ctx);try{await assert.rejects(mutationCommon.inspectDriverMutationAdmission({...ctx},adInput(ctx,pair)),{message:'GUARD_OWNER_CONTEXT'});}finally{await ctx.close();}
    await refresh(MUT_DRIVER);ctx=await mutationCommon.requireCurrentOwner(MUT_DRIVER,ids.owners[MUT_DRIVER].peer,'read');
    try{await assert.rejects(adCall(ctx,pair),{message:'GUARD_OWNER_MUTATION_PURPOSE'});}finally{await ctx.close();}
    ctx=await mutFresh(MUT_AI);try{await assert.rejects(adCall(ctx,pair),{message:'GUARD_OWNER_MUTATION_PURPOSE'});}finally{await ctx.close();}
    assert.equal(await mutLockFree(),true);
  });
  await mutCase(AD_GROUPS[3],async()=>{
    await mutSeedPending();const ctx=await mutFresh();try{const pair=await adPair(ctx);await adCheck(ctx,pair,'receipt',await adCall(ctx,pair));}finally{await ctx.close();}
    assert.equal((await registry.query('SELECT cleanup_status FROM cop_guard.checkpoint_acceptances WHERE acceptance_id=$1',[ids.owners[MUT_DRIVER].acceptanceId])).rows[0].cleanup_status,'pending');
    await assert.rejects(mutationCommon.requireCurrentOwner(MUT_DRIVER,ids.owners[MUT_DRIVER].peer,'read'),{message:'GUARD_OWNER_CHECKPOINT_PENDING'});assert.equal(await mutLockFree(),true);
  });
  await mutCase(AD_GROUPS[4],async()=>{
    const ctx=await mutFresh();try{
      const pair=await adPair(ctx);await adCheck(ctx,pair,'receipt',await adCall(ctx,pair));
      await assert.rejects(adCall(ctx,pair,'receipt',{mutationScopeRef:{...pair.scope.ref,digest:'0'.repeat(64)}}),{message:'GUARD_OWNER_RECORD_REFERENCE'});
      const original=await readFile(pair.scope.path),forged=canonicalJson(original);forged.payload.sourceProofId=randomUUID();
      await privateFile(pair.scope.path,canonical(forged)+'\n');try{await assert.rejects(adCall(ctx,pair));}finally{await privateFile(pair.scope.path,original);}
      for(const overrides of [{unknown:true},{scopeId:'not-a-uuid'},{actionKind:'revoke'},{peer:{...ctx.peer,inode:String(BigInt(ctx.peer.inode)+1n)}},{owner:MUT_AI},{scope:'cop_router_primary_database'},
        {sourceProofId:randomUUID()},{frontierSequence:ctx.frontierSequence+1},{frontierDigest:hash('wrong frontier')},{authorityRef:{recordId:randomUUID(),digest:hash('wrong ctx ref')}},
        {intentRef:{recordId:randomUUID(),digest:hash('wrong intent ref')}},{guardStoreId:randomUUID()},{continuityEpoch:randomUUID()},{datasetBindingId:randomUUID()},
        {runtimeBindingId:randomUUID()},{storeIncarnation:randomUUID()},{requestDigest:hash('wrong HTTP scope digest')}]){
        const intent=await mutIntent(ctx),bad={intent,scope:await adScope(ctx,intent,{overrides})};await assert.rejects(adCall(ctx,bad),{message:'GUARD_OWNER_MUTATION_SCOPE'});
      }
      for(const key of ['operationHash','actorHash','requestHash','checkpointHash']){const fresh=await adPair(ctx);await assert.rejects(adCall(ctx,fresh,'receipt',{[key]:hash('wrong '+key)}),{message:'GUARD_OWNER_MUTATION_INTENT'});}
      const good=await adPair(ctx);await assert.rejects(mutationCommon.inspectDriverMutationAdmission(ctx,{...adInput(ctx,good),extra:true}),{message:'GUARD_OWNER_MUTATION_FACTS_REQUEST'});
      const{mutationScopeRef,...missingScope}=adInput(ctx,good);
      await assert.rejects(mutationCommon.inspectDriverMutationAdmission(ctx,missingScope),{message:'GUARD_OWNER_MUTATION_FACTS_REQUEST'});
      await assert.rejects(adCall(ctx,good,'capability'),{message:'GUARD_OWNER_MUTATION_FACTS_REQUEST'});
      await chmod(PRIVATE+'/mutation-scopes',0o750);
      try{await assert.rejects(adCall(ctx,good),{message:'GUARD_PARENT_CUSTODY'});}finally{await chmod(PRIVATE+'/mutation-scopes',0o700);}
      await adCheck(ctx,good,'receipt',await adCall(ctx,good));
    }finally{await ctx.close();}assert.equal(await mutLockFree(),true);
  });
  await mutCase(AD_GROUPS[5],async()=>{
    const ctx=await mutFresh();try{
      const pair=await adPair(ctx,{intentOptions:{ttl:3000},scopeOptions:{ttl:1800}}),out=await adCall(ctx,pair);await adCheck(ctx,pair,'receipt',out);
      const long=await adPair(ctx,{scopeOptions:{ttl:6000}});await assert.rejects(adCall(ctx,long),{message:'GUARD_OWNER_MUTATION_SCOPE'});
      const longIntent=await adPair(ctx,{intentOptions:{ttl:6000},scopeOptions:{ttl:3000}});await assert.rejects(adCall(ctx,longIntent),{message:'GUARD_OWNER_MUTATION_INTENT'});
    }finally{await ctx.close();}assert.equal(await mutLockFree(),true);
  });
  await mutCase(AD_GROUPS[6],async()=>{
    for(const expire of ['scope','intent']){
      const ctx=await mutFresh();try{
        const pair=await adPair(ctx,{intentOptions:{ttl:expire==='intent'?700:5000},scopeOptions:{ttl:expire==='scope'?500:400}});
        const before=await mutSnapshot(),files=await mutProtected(),bytes=await readFile(pair.scope.path),intentBytes=await readFile(pair.intent.path);
        const deadline=expire==='intent'?pair.intent.record.payload.expiresAt:pair.scope.record.payload.expiresAt;
        await delay(Math.max(1,Date.parse(deadline)-Date.now()+60));await assert.rejects(adCall(ctx,pair));assert.equal(await mutLockFree(),false);
        assert.deepEqual(await mutSnapshot(),before);assert.deepEqual(await mutProtected(),files);assert.deepEqual(await readFile(pair.scope.path),bytes);assert.deepEqual(await readFile(pair.intent.path),intentBytes);
      }finally{await ctx.close();}assert.equal(await mutLockFree(),true);
    }
    const ctx=await mutFresh(MUT_DRIVER,2500);try{
      const pair=await adPair(ctx),before=await mutSnapshot(),files=await mutProtected();await delay(Math.max(1,Date.parse(ctx.expiresAtUTC)-Date.now()+60));
      await assert.rejects(adCall(ctx,pair));assert.equal(await mutLockFree(),false);assert.deepEqual(await mutSnapshot(),before);assert.deepEqual(await mutProtected(),files);
    }finally{await ctx.close();}assert.equal(await mutLockFree(),true);
  });
  await mutCase(AD_GROUPS[7],async()=>{
    const ctx=await mutFresh(),held=await mutSessions();assert.equal(held.length,1);assert.equal(held[0].ssl,true);assert.equal((await mutTargetSessions()).length,0);
    try{
      const first=await adPair(ctx),second=await adPair(ctx),before=await mutSnapshot(),files=await mutProtected();
      const out=await Promise.all([adCall(ctx,first),adCall(ctx,second,'status')]);await adCheck(ctx,first,'receipt',out[0]);await adCheck(ctx,second,'status',out[1]);
      assert.deepEqual(await mutSessions(),held);assert.equal((await mutTargetSessions()).length,0);assert.equal(await mutLockFree(),false);
      assert.deepEqual(await mutSnapshot(),before);assert.deepEqual(await mutProtected(),files);
    }finally{await ctx.close();}assert.equal((await mutSessions()).length,0);assert.equal(await mutLockFree(),true);
  });
  await mutCase(AD_GROUPS[8],async()=>{
    const ctx=await mutFresh(),pair=await adPair(ctx),held=await mutSessions(),before=await mutSnapshot();const locker=await open(MUT_DRIVER);let pending;
    try{
      await locker.query('BEGIN');await locker.query('LOCK TABLE public.driver_account_erasure_operations IN ACCESS EXCLUSIVE MODE');
      pending=adCall(ctx,pair).then(()=>({ok:true}),error=>({ok:false,message:error.message}));let target;
      const until=Date.now()+900;while(Date.now()<until){target=(await driverAdmin.query("SELECT pid FROM pg_stat_activity WHERE datname='sim_driver_measurements' AND usename='sim_driver_guard_control' AND application_name='cop-root-owner-authority-v1' AND wait_event_type='Lock'")).rows[0];if(target)break;await delay(10);}
      assert.ok(target);assert.equal((await driverAdmin.query('SELECT ssl FROM pg_stat_ssl WHERE pid=$1',[target.pid])).rows[0].ssl,true);
      assert.equal((await driverAdmin.query('SELECT pg_terminate_backend($1) AS stopped',[target.pid])).rows[0].stopped,true);assert.equal((await pending).ok,false);
      await assert.rejects(ctx.close(),{message:'GUARD_OWNER_HOLD'});await assert.rejects(mutationCommon.requireCurrentOwner(MUT_AI,ids.owners[MUT_AI].peer,'mutation'),{message:'GUARD_OWNER_REQUEST'});
      assert.equal(await mutLockFree(),false);assert.deepEqual(await mutSessions(),held);
    }finally{await locker.query('ROLLBACK');if(pending)await pending;await locker.end();clients.delete(locker);}
    assert.deepEqual(await mutSnapshot(),before);
  });
  assert.deepEqual(events.map(row=>row.case),AD_GROUPS);for(const[path,pin]of Object.entries(pins))assert.equal(hash(await readFile(path)),pin);
  return{contractVersion:'sim-driver-mutation-admission-root-v1',passed:events.length,cases:events,startedAt,completedAt:new Date().toISOString(),
    actualDedicatedSigner:true,actualWeakMapContext:true,actualRootSignatures:true,realJws:true,realStrictTls:true,realMetadata001:true,realTargetSql004:true,realTargetSql007:true,
    realPg904214Leases:true,actualSql003SyntheticOriginSeed:true,firstPostAnchorRejected:true,actualCopIntentProducerExecuted:false,actualRootDispatch:false,
    mutationIntentSynthetic:true,mutationScopeSynthetic:true,rootKeeperExercised:false,factsDigestIndependentlyRecomputed:false,
    ttlCoverage:{checkedAllReturnedCeilings:true,independentlyShortest:['scope'],actualExpiry:['scope','intent','context'],
      targetProofAndFactsAgeIndependentlyShortestExercised:false},
    hostObservationSynthetic:true,actualHostObserverExecuted:false,appPeerSynthetic:true,actualPidfdSelf:true,singleRootProcess:true,
    nativeTransport:false,providerCalls:0,authorityCallbacks:0,pgStubs:0,actualTargetDisconnectHold:true,unknownTargetEndExercised:false,
    lostCommitExercised:false,sourceRenewedByHelper:false,globalHoldNotReset:true,productionEnrollment:false,productionChanged:false,
    deploymentAccepted:false,restoreAccepted:false,wholeAccountComplete:false};
}
try{assert.deepEqual(process.argv.slice(2),['--run']);adResult=await runAdmission();}catch(error){adFailure=error;}
finally{
  clearInterval(hostTimer);for(const jobs of pendingHostWrites.values())await Promise.allSettled([...jobs]);for(const client of clients)await client.end().catch(()=>{});
  // Owned fixture destruction is not a production HOLD/restore recovery.
  if(started)await pgCommand('pg_ctl',['-D',PGROOT+'/data','-m','immediate','-w','stop']).catch(()=>{});clearTimeout(deadline);
}
if(adFailure){const message=typeof adFailure.message==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(adFailure.message)?adFailure.message:'FIXTURE_ASSERTION_FAILED';
  const sqlState=typeof adFailure.code==='string'&&/^[0-9A-Z]{5}$/.test(adFailure.code)?adFailure.code:null;
  const site=typeof adFailure.stack==='string'?/\/fixture\/harness\.mjs:([0-9]{1,6}):([0-9]{1,4})\b/.exec(adFailure.stack):null;
  console.log(JSON.stringify({contractVersion:'sim-driver-mutation-admission-root-v1',passed:false,stage,failure:message,sqlState,failureSite:site?'harness.mjs:'+site[1]+':'+site[2]:null}));process.exitCode=1;
}else console.log(JSON.stringify(adResult));
