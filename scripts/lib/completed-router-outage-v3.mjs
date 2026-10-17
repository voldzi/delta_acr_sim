/** Separate completed-operation contract. Never rewrite/relax a v2 pending case. */
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
