// Execute in COP API: read its existing token from env, never print it.
// Synthetic revocation only; no GPS, no grant, no intake enablement.
const base=process.env.COP_DRIVER_MEASUREMENTS_SIM_URL;
const token=process.env.COP_DRIVER_MEASUREMENTS_SIM_TOKEN;
if(!base?.startsWith('http://sim-driver-measurements:4020/') || !token)throw new Error('Internal measurement configuration missing');
const results=[];
async function check(name,path,method,body,expected,authenticated=true){
  const r=await fetch(base+path,{method,signal:AbortSignal.timeout(10000),redirect:'error',headers:{'Content-Type':'application/json',
    'x-correlation-id':'synthetic-measurement-privacy-probe',...(authenticated?{Authorization:`Bearer ${token}`}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  await r.arrayBuffer();
  results.push({name,status:r.status,expected});
  if(r.status!==expected)throw new Error(`Unexpected status for ${name}: ${r.status}`);
}
try{
  await check('no-token','/contributions','DELETE',{},401,false);
  await check('invalid-delete','/contributions','DELETE',{private:'synthetic-privacy-probe'},400);
  await check('disabled-intake','/batches','POST',{},503);
  await check('disabled-aggregates','/aggregates','GET',undefined,503);
  await check('synthetic-delete','/contributions','DELETE',{contractVersion:'sim-driver-measurements-v1',contributorIdDay:'synthetic-production-acceptance-only-20261002'},200);
  // Invalid requests consume the shared service budget but never touch the DB.
  let throttled=false;
  for(let n=0;n<121;n++){
    const r=await fetch(base+'/contributions',{method:'DELETE',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:'{}'});
    await r.arrayBuffer();
    if(r.status===429){throttled=true;break;}
    if(r.status!==400)throw new Error('Unexpected limiter response');
  }
  if(!throttled)throw new Error('Service limiter not enforced');
  results.push({name:'service-rate-limit',status:429,expected:429});
  console.log(JSON.stringify({internalSmoke:'passed',results}));
}catch{console.error(JSON.stringify({internalSmoke:'failed',results}));process.exitCode=1;}
