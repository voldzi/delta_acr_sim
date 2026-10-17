import assert from 'node:assert/strict';
import {validateCompletedRouterOutageV3 as validate} from './lib/completed-router-outage-v3.mjs';
const expected={operationId:'b1c21024-0c2f-4a3d-afad-911f95d73c1b',resetEpoch:'a7f98504-9c29-4942-8fb3-7236ab819a07',routerImage:'sha256:'+'a'.repeat(64),testBundleImage:'sha256:'+'b'.repeat(64)};
const names=['ai','driver','history','main'];
const phase=(httpStatus,loginAllowed)=>({httpStatus,loginAllowed,...(httpStatus===200?{httpState:'deleted'}:{}),databaseBindings:Object.fromEntries(names.map(n=>[n,{operationId:expected.operationId,resetEpoch:expected.resetEpoch,accountState:'deleted'}]))});
const value={contractVersion:'sim-router-completed-operation-outage-v3',caseType:'already_completed_operation',...expected,phases:{before:phase(200,true),during:phase(503,false),after:phase(200,true)},preservation:Object.fromEntries(['userB','jobsAndBindings','finance','independentGuard'].map(k=>[k,{before:'c'.repeat(64),after:'c'.repeat(64)}])),finalReadbacks:Object.fromEntries(names.map(n=>[n,{httpStatus:200,state:'deleted',remaining:0}])),productionTouched:false,reseeded:false,externalProviderAttempts:0,loginRestored:true,pendingDeletionOutageClaimed:false};
assert.equal(validate(value,expected).pendingDeletionOutageProven,false);let checks=1;
for(const change of [
 e=>e.contractVersion='cop-sim-whole-clean-acceptance-v2',
 e=>e.caseType='pending',
 e=>e.operationId='other',
 e=>e.resetEpoch='other',
 e=>e.routerImage='sha256:'+'d'.repeat(64),
 e=>e.phases.during.httpStatus=200,
 e=>e.phases.during.httpState='deleting',
 e=>e.phases.during.loginAllowed=true,
 e=>e.phases.after.httpState='deleting',
 e=>e.phases.after.databaseBindings.ai.resetEpoch='other',
 e=>e.phases.before.databaseBindings.main.operationId='other',
 e=>e.phases.during.databaseBindings.driver.accountState='deletion_pending',
 e=>delete e.phases.during.databaseBindings.history,
 e=>e.preservation.finance.after='d'.repeat(64),
 e=>delete e.preservation.independentGuard,
 e=>e.finalReadbacks.main.remaining=1,
 e=>e.finalReadbacks.history.httpStatus=503,
 e=>e.finalReadbacks.ai.state='pending',
 e=>e.loginRestored=false,
 e=>e.productionTouched=true,
 e=>e.externalProviderAttempts=1,
 e=>e.pendingDeletionOutageClaimed=true
]){const e=structuredClone(value);change(e);assert.throws(()=>validate(e,expected),/V3_UNPROVEN/);checks++;}
console.log(JSON.stringify({checks,syntheticContractOnly:true,v2GateChanged:false,productionTouched:false}));
