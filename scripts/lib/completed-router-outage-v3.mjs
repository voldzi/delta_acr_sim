/** Separate completed-operation contract. Never rewrite/relax a v2 pending case. */
import {createHash} from 'node:crypto';
const need=x=>{if(!x)throw Error('COMPLETED_ROUTER_OUTAGE_V3_UNPROVEN')};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const image=x=>typeof x==='string'&&/^sha256:[a-f0-9]{64}$/.test(x);
export function validateCompletedRouterOutageV3(e,expected){
 need(e?.contractVersion==='sim-router-completed-operation-outage-v3'&&e.caseType==='already_completed_operation');
 need(uuid(expected?.operationId)&&uuid(expected?.resetEpoch)&&image(expected?.routerImage)&&image(expected?.testBundleImage));
 for(const k of ['operationId','resetEpoch','routerImage','testBundleImage'])need(e[k]===expected[k]);
 need(e.productionTouched===false&&e.reseeded===false&&e.externalProviderAttempts===0&&e.loginRestored===true);
 need(Object.keys(e.phases??{}).sort().join()==='after,before,during');
 for(const[phase,status]of [['before',200],['during',503],['after',200]]){
  const p=e.phases?.[phase];need(p?.httpStatus===status);
  if(phase!=='during')need(p.httpState==='deleted');
  else need(!['deleting','deletion_pending','pending'].includes(p.httpState));
  need(p.loginAllowed===(phase!=='during'));
  need(Object.keys(p.databaseBindings??{}).sort().join()===['ai','driver','history','main'].sort().join());
  for(const b of Object.values(p.databaseBindings))need(b.operationId===expected.operationId&&b.resetEpoch===expected.resetEpoch&&b.accountState==='deleted');
 }
 need(Object.keys(e.preservation??{}).sort().join()==='finance,independentGuard,jobsAndBindings,userB');
 for(const key of ['userB','jobsAndBindings','finance','independentGuard']){
  const x=e.preservation?.[key];need(hex(x?.before)&&x.before===x.after);
 }
 need(Object.keys(e.finalReadbacks??{}).sort().join()===['ai','driver','history','main'].sort().join());
 for(const x of Object.values(e.finalReadbacks))need(x.httpStatus===200&&x.state==='deleted'&&x.remaining===0);
 need(e.pendingDeletionOutageClaimed===false);
 return {contractVersion:e.contractVersion,caseType:e.caseType,operationId:e.operationId,resetEpoch:e.resetEpoch,sequence:[200,503,200],finalAllZero:true,pendingDeletionOutageProven:false};
}
/** Lossless evidence projection: digest actual SQL witnesses from each phase,
 * never invent a COP SQL row, transplant another test's digest or rerun a job. */
export function toCopCompletedRouterOutageV3(e,expected){
 validateCompletedRouterOutageV3(e,expected);
 const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const databaseBindingReadbacks=Object.fromEntries(['before','during','after'].map(phase=>{
  const witness=e.phases[phase].databaseBindings;
  const ordered=Object.fromEntries(['ai','driver','main','history'].map(k=>[k,witness[k]]));
  return [phase,{operationId:e.operationId,resetEpoch:e.resetEpoch,operationState:'deleted',terminalBindingDigest:digest(ordered)}];
 }));
 need(new Set(Object.values(databaseBindingReadbacks).map(x=>x.terminalBindingDigest)).size===1);
 return {phase:'completed_operation_replay',dependencyHttpSequence:['before','during','after'].map(k=>e.phases[k].httpStatus),
  operationStatus:e.phases.before.httpState,operationCompletedBeforeOutage:e.phases.before.httpState==='deleted',databaseBindingReadbacks,
  finalReadback:{operationId:e.operationId,resetEpoch:e.resetEpoch,status:'completed',userARemaining:Object.values(e.finalReadbacks).reduce((n,x)=>n+x.remaining,0),readbackDigest:digest(e.finalReadbacks)},
  evidenceContract:e.contractVersion,evidenceSha256:digest(e),databaseWitnessSource:'actual_sim_four_database_sql_phase_readbacks',
  pendingDeletionOutageProven:false,productionTouched:false};
}
