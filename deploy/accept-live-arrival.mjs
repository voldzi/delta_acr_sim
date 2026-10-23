// Public, approved Penny coordinates only; output aggregate proof, no raw shapes.
import { canonicalRoutingHash } from './apps/situation-data-api/dist/routing-safety.js';
import { arrivalDistance } from './apps/situation-data-api/dist/user-selected-arrival.js';
try {
const base='http://127.0.0.1:4020/api/v1/routing';
const from={lat:50.1209513,lon:17.3831568}, target={lat:50.1215849,lon:17.3810814}, access={lat:50.1214775,lon:17.3814008};
async function route(body){const r=await fetch(base+'/alternatives',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});return {status:r.status,body:await r.json()};}
const cap=await(await fetch(base+'/profiles')).json();
if(cap.userSelectedArrival?.version!=='sim-user-selected-arrival-v1'||cap.userSelectedArrival?.availability!=='requires_runtime_validation')throw Error('CAPABILITY_FAILED');
const original=await route({profileId:'car',from,to:target,includeSteps:true,includeRoadAttributes:true,alternatives:3});
if(original.status!==422||original.body.error?.code!=='ROUTING_RESTRICTIONS_RELAXATION_REQUIRED')throw Error('ADDRESS_RELAXATION_REJECTION_FAILED');
const request={profileId:'car',from,to:access,arrival:{version:'sim-user-selected-arrival-v1',selection:'user_selected',target},includeSteps:true,includeRoadAttributes:true,alternatives:3};
const accepted=await route(request);
if(accepted.status!==200||!accepted.body.routes?.length)throw Error('USER_SELECTED_ACCESS_FAILED');
const queryHash=canonicalRoutingHash(accepted.body.query);
const variants=[];
for(const r of accepted.body.routes){const a=r.arrival,k=r.knownClosures;const end=r.geometry.coordinates.at(-1);
 if(!a||!k||r.status!=='ok'||r.quality.mode!=='engine_route'||r.vehicleAssessment?.providerCosting!=='auto'||a.engine?.fallbackUsed!==false||a.engine?.version!==k.engine?.version||a.engine?.costing!=='auto'||a.requestHash!==queryHash||k.requestHash!==queryHash||a.geometryHash!==canonicalRoutingHash(r.geometry)||a.geometryHash!==k.geometryHash||a.closureRevision!==k.revision||canonicalRoutingHash(a.routingDataset)!==canonicalRoutingHash(k.routingDataset)||a.routeId!==r.routeId||Date.parse(a.validUntil)<=Date.now()||Date.parse(a.validUntil)>Date.parse(k.validUntil)||a.distanceM>250||a.snapDistanceM>25||a.remainingAccess!=='unverified'||Math.abs(a.distanceM-arrivalDistance(target,{lon:end[0],lat:end[1]}))>.01||JSON.stringify(accepted.body.features.find(f=>f.id===r.routeId)?.properties.arrival)!==JSON.stringify(a))throw Error('ARRIVAL_PROOF_FAILED');
 variants.push({distanceM:r.distanceM,durationSeconds:r.durationSeconds,remainingDistanceM:a.distanceM,snapDistanceM:a.snapDistanceM,steps:r.steps.length,graph:a.routingDataset.version,engine:a.engine,proofVerified:true});
}
const invalid=await route({...request,via:[]});
if(invalid.status!==422||invalid.body.error?.code!=='ROUTING_ARRIVAL_UNSUPPORTED')throw Error('UNSUPPORTED_COMBINATION_FAILED');
console.log(JSON.stringify({verified:true,publicPenny:true,original:{http:original.status,code:original.body.error.code},selectedAccess:{http:accepted.status,variants},unsupported:{http:invalid.status,code:invalid.body.error.code},authenticatedCopSdkAcceptancePending:true}));
} catch(error) {
 const allowed=['CAPABILITY_FAILED','ADDRESS_RELAXATION_REJECTION_FAILED','USER_SELECTED_ACCESS_FAILED','ARRIVAL_PROOF_FAILED','UNSUPPORTED_COMBINATION_FAILED'];
 console.log(JSON.stringify({verified:false,failureCode:allowed.includes(error.message)?error.message:'HTTP_PROBE_FAILED'}));
}
