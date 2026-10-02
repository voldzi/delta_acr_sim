import express from "express";
import request from "supertest";
import { describe,it,expect,vi } from "vitest";
import { DRIVER_CONTRACT,DriverMeasurementError,deriveDriverIntervals,driverSettings,parseDriverBatch,registerDriverMeasurementRoutes,ValhallaDriverMatcher,
  type DriverBatch,type DriverMatch,type DriverStore,type DriverReceipt } from "../src/driver-measurements.js";
import type { SituationDataConfig } from "../src/config.js";

const now=Date.parse("2026-10-01T12:05:00.000Z"), dataset="sim-routing-2026-09-29-1790679143", token="t".repeat(40);
function batch():DriverBatch {
  return {contractVersion:DRIVER_CONTRACT,batchId:"00000000-0000-4000-8000-000000000001",contributorIdDay:"a".repeat(40),contributorDay:"2026-10-01",
    vehicleClass:"passenger_car",consent:{version:"traffic-quality-v1",grantedAt:"2026-10-01T10:00:00.000Z",attestation:"cop-driver-consent-v1"},
    points:[0,1,2].map(i=>({sampleId:`00000000-0000-4000-8000-${String(i+10).padStart(12,"0")}`,observedAt:new Date(now-20000+i*5000).toISOString(),
      lat:50,lon:14+i*.0007,horizontalAccuracyM:3,speedMps:10,speedAccuracyMps:.5,headingDeg:90,headingAccuracyDeg:5,
      positionSource:"gps",motion:"driving",reducedAccuracy:false}))};
}
const match=():DriverMatch=>({dataset,points:[0,1,2].map(i=>({edgeId:"8",fraction:.1+i*.1,distanceM:2,matched:true,disconnected:false,edgeLengthM:500}))});
function eta(b:DriverBatch) {b.eta={observationId:"00000000-0000-4000-8000-000000000099",routingDataset:dataset,predictedDurationSeconds:100,actualDurationSeconds:120,plannedDistanceM:1000,actualDistanceM:1010,personalStopSeconds:0,estimatedSeconds:0,offRoute:false,completedAt:new Date(now-10000).toISOString()};return b;}

describe("driver measurements validation and derivation",()=>{
  it("validates revocation-only credentials and keeps flags default off",()=>{
    try {
      vi.stubEnv("DRIVER_MEASUREMENTS_ENABLED","false");vi.stubEnv("DRIVER_MEASUREMENTS_REVOCATION_ENABLED","false");
      vi.stubEnv("DRIVER_MEASUREMENTS_DATABASE_URL","");vi.stubEnv("DRIVER_MEASUREMENTS_COP_TOKEN","");vi.stubEnv("DRIVER_MEASUREMENTS_HASH_SECRET","");
      expect(driverSettings()).toMatchObject({enabled:false,revocationEnabled:false});
      vi.stubEnv("DRIVER_MEASUREMENTS_REVOCATION_ENABLED","true");expect(()=>driverSettings()).toThrow("Invalid driver-measurement configuration");
      vi.stubEnv("DRIVER_MEASUREMENTS_DATABASE_URL","postgresql://synthetic.invalid/test");vi.stubEnv("DRIVER_MEASUREMENTS_COP_TOKEN",token);vi.stubEnv("DRIVER_MEASUREMENTS_HASH_SECRET","s".repeat(40));
      expect(driverSettings()).toMatchObject({enabled:false,revocationEnabled:true});
    } finally {vi.unstubAllEnvs();}
  });
  it("accepts strict measured input, no coercion, ordered GPS",()=>{expect(parseDriverBatch(batch(),now)).toEqual(batch());});
  it("rejects unknown keys recursively and personal data",()=>{
    for(const change of [(b:any)=>b.name="person",(b:any)=>b.points[0].registration="plate",(b:any)=>b.consent.user="user",(b:any)=>{eta(b);b.eta.routeText="home";}]) {
      const b=batch();change(b);expect(()=>parseDriverBatch(b,now)).toThrow();
    }
  });
  it("requires consent and rejects false attestation",()=>{const b=batch();(b.consent as any).attestation="automatic";expect(()=>parseDriverBatch(b,now)).toThrow("DRIVER_CONSENT_REQUIRED");});
  it("rejects duplicate samples, unordered, future, old and cross-day data",()=>{
    for(const change of [(b:any)=>b.points[1].sampleId=b.points[0].sampleId,(b:any)=>b.points[1].observedAt=b.points[0].observedAt,
      (b:any)=>b.points[2].observedAt=new Date(now+60000).toISOString(),(b:any)=>b.points[0].observedAt="2026-09-29T12:00:00Z",(b:any)=>b.contributorDay="2026-09-30"]) {
      const b=batch();change(b);expect(()=>parseDriverBatch(b,now)).toThrow();
    }
  });
  it("rejects ranges, string numerics, invalid IDs and wrong vehicle mode",()=>{
    for(const change of [(b:any)=>b.points[0].speedMps="10",(b:any)=>b.points[0].speedMps=-1,(b:any)=>b.points[0].lon=181,
      (b:any)=>b.batchId="user@example.com",(b:any)=>b.contributorIdDay="device",(b:any)=>b.vehicleClass="bicycle",(b:any)=>b.points=Array(121).fill(b.points[0])]) {
      const b=batch();change(b);expect(()=>parseDriverBatch(b,now)).toThrow();
    }
  });
  it("derives graph-scoped direction and measured speed without persisting coordinates",()=>{
    const r=deriveDriverIntervals(batch(),match());expect(r.intervals).toHaveLength(2);expect(r.intervals[0].speedKph).toBeCloseTo(36);
    expect(r.intervals[0].dataset).toBe(dataset);expect(JSON.stringify(r)).not.toContain('"lat"');expect(JSON.stringify(r)).not.toContain('"lon"');
  });
  it.each(["estimated","simulated"])("never turns %s positions into measured speeds",source=>{const b=batch();b.points.forEach(p=>p.positionSource=source as any);expect(deriveDriverIntervals(b,match()).intervals).toHaveLength(0);});
  it("rejects wrong direction, interpolation, gaps, inconsistent speed and edge ambiguity",()=>{
    for(const change of [(b:DriverBatch,m:DriverMatch)=>{m.points[1].fraction=.05;},(b:DriverBatch,m:DriverMatch)=>{m.points.forEach(p=>p.matched=false);},
      (b:DriverBatch,m:DriverMatch)=>{m.points[1].edgeId="16";},(b:DriverBatch,m:DriverMatch)=>{b.points[1].horizontalAccuracyM=50;},
      (b:DriverBatch,m:DriverMatch)=>{b.points[1].motion="personal_stop";},(b:DriverBatch,m:DriverMatch)=>{b.points.forEach(p=>p.speedMps=60);},
      (b:DriverBatch,m:DriverMatch)=>{m.points[1].distanceM=20;}]) {
      const b=batch(),m=match();change(b,m);expect(deriveDriverIntervals(b,m).intervals.length).toBeLessThan(2);
    }
    const b=batch();b.points[1].observedAt=new Date(now+50000).toISOString();expect(deriveDriverIntervals(b,match()).intervals).toHaveLength(0);
  });
  it("ETA is retained only as comparable self-report, never independent ground truth",()=>{
    expect(deriveDriverIntervals(eta(batch()),match()).etaAccepted).toBe(true);
    for(const field of ["offRoute","estimatedSeconds","personalStopSeconds","routingDataset","actualDistanceM"]) {
      const b=eta(batch());(b.eta as any)[field]=field==="offRoute"?true:field==="routingDataset"?"sim-routing-2026-09-01-123":field==="actualDistanceM"?2000:10;
      expect(deriveDriverIntervals(b,match()).etaAccepted).toBe(false);
    }
  });
  it("rejects inconsistent heading and negative matcher distances",()=>{
    const b=batch();b.points.forEach(p=>p.headingDeg=270);expect(deriveDriverIntervals(b,match()).intervals).toHaveLength(0);
    const m=match();m.points.forEach(p=>p.distanceM=-1);expect(deriveDriverIntervals(batch(),m).intervals).toHaveLength(0);
  });
});

function fixture(options:{enabled?:boolean;revocationEnabled?:boolean;rate?:number}={}) {
  const saved=new Map<string,{hash:string;receipt:DriverReceipt}>(), revoked=new Set<string>();
  const store:DriverStore={lookup:vi.fn(async(_owner,id,hash)=>{const p=saved.get(id);if(p&&p.hash!==hash)throw new DriverMeasurementError(409,"DRIVER_IDEMPOTENCY_CONFLICT");return p?.receipt;}),
    commit:vi.fn(async(_owner,contributor,hash,b,intervals,r)=>{if(revoked.has(contributor))throw new DriverMeasurementError(403,"DRIVER_CONSENT_REVOKED");saved.set(b.batchId,{hash,receipt:r});return r;}),
    aggregates:vi.fn(async()=>[]),quality:vi.fn(async()=>({acceptedIntervalCount:2})),revoke:vi.fn(async(_owner,hash)=>{revoked.add(hash);saved.clear();return 1;}),close:vi.fn(async()=>{})};
  const matcher={match:vi.fn(async()=>match()),dataset:vi.fn(async()=>dataset)},app=express();app.use(express.json({limit:"1mb"}));
  registerDriverMeasurementRoutes(app,{} as SituationDataConfig,{enabled:options.enabled??true,revocationEnabled:options.revocationEnabled,token,hashSecret:"s".repeat(40),ratePerMinute:options.rate??120},{store,matcher,now:()=>now});
  return {app,store,matcher};
}
const path="/api/v1/internal/driver-measurements/v1";
describe("driver measurements HTTP boundary",()=>{
  it("sanitizes malformed/oversized JSON without echoing the request",async()=>{
    const {app}=fixture();const malformed=await request(app).post(`${path}/batches`).set("Content-Type","application/json").send('{"private":notjson}');
    expect(malformed.status).toBe(400);expect(JSON.stringify(malformed.body)).not.toContain("private");
    const large=await request(app).post(`${path}/batches`).set("Content-Type","application/json").send(JSON.stringify({private:"x".repeat(1048576)}));
    expect(large.status).toBe(413);expect(large.body.error.code).toBe("DRIVER_PAYLOAD_TOO_LARGE");
  });
  it("rejects unauthorized and browser access",async()=>{const {app}=fixture();expect((await request(app).post(`${path}/batches`).send(batch())).status).toBe(401);
    expect((await request(app).post(`${path}/batches`).set("Authorization",`Bearer ${token}`).set("Origin","https://cop.example").send(batch())).status).toBe(403);});
  it("disabled intake does not affect other routes",async()=>{const {app}=fixture({enabled:false});app.get("/health/live",(_,r)=>r.json({status:"ok"}));
    expect((await request(app).get("/health/live")).status).toBe(200);expect((await request(app).post(`${path}/batches`).set("Authorization",`Bearer ${token}`).send(batch())).status).toBe(503);});
  it("rollback can retain authenticated deletion only, without matching or reads",async()=>{
    const {app,store,matcher}=fixture({enabled:false,revocationEnabled:true});
    const deletion={contractVersion:DRIVER_CONTRACT,contributorIdDay:batch().contributorIdDay};
    expect((await request(app).delete(`${path}/contributions`).send(deletion)).status).toBe(401);
    expect((await request(app).delete(`${path}/contributions`).set("Authorization",`Bearer ${token}`).set("Origin","https://cop.example").send(deletion)).status).toBe(403);
    const result=await request(app).delete(`${path}/contributions`).set("Authorization",`Bearer ${token}`).send(deletion);
    expect(result.status).toBe(200);expect(result.body.deletedBatchCount).toBe(1);
    expect(store.revoke).toHaveBeenCalledTimes(1);
    expect((await request(app).post(`${path}/batches`).set("Authorization",`Bearer ${token}`).send(batch())).status).toBe(503);
    for(const endpoint of ["quality","aggregates"])expect((await request(app).get(`${path}/${endpoint}`).set("Authorization",`Bearer ${token}`)).status).toBe(503);
    expect(matcher.match).not.toHaveBeenCalled();expect(matcher.dataset).not.toHaveBeenCalled();
  });
  it("deletion remains default disabled and storage failure cannot report success",async()=>{
    const deletion={contractVersion:DRIVER_CONTRACT,contributorIdDay:batch().contributorIdDay};
    const off=fixture({enabled:false});expect((await request(off.app).delete(`${path}/contributions`).set("Authorization",`Bearer ${token}`).send(deletion)).status).toBe(503);
    const rollback=fixture({enabled:false,revocationEnabled:true});(rollback.store.revoke as any).mockRejectedValue(new Error("private DB detail"));
    const result=await request(rollback.app).delete(`${path}/contributions`).set("Authorization",`Bearer ${token}`).send(deletion);
    expect(result.status).toBe(503);expect(JSON.stringify(result.body)).not.toContain("private DB detail");
  });
  it("uses authenticated COP identity, no raw positions in persistence, and exact replay",async()=>{
    const {app,store,matcher}=fixture();const a=await request(app).post(`${path}/batches`).set("Authorization",`Bearer ${token}`).send(batch());
    expect(a.status).toBe(200);expect(a.body.acceptedIntervalCount).toBe(2);expect(a.body.rawPositionsStored).toBe(false);
    expect((store.commit as any).mock.calls[0][0]).toBe("cop");expect((store.commit as any).mock.calls[0][1]).not.toBe(batch().contributorIdDay);
    const b=await request(app).post(`${path}/batches`).set("Authorization",`Bearer ${token}`).send(batch());expect(b.body).toEqual(a.body);expect(b.headers["x-idempotent-replay"]).toBe("true");expect(matcher.match).toHaveBeenCalledTimes(1);
    const changed=batch();changed.points[0].speedMps=11;expect((await request(app).post(`${path}/batches`).set("Authorization",`Bearer ${token}`).send(changed)).status).toBe(409);
  });
  it("returns bounded contributor and service rate errors",async()=>{const f=fixture({rate:1});
    await request(f.app).post(`${path}/batches`).set("Authorization",`Bearer ${token}`).send(batch());expect((await request(f.app).get(`${path}/quality`).set("Authorization",`Bearer ${token}`)).status).toBe(429);
    const g=fixture();for(let i=0;i<3;i++){const b=batch();b.batchId=`00000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`;const r=await request(g.app).post(`${path}/batches`).set("Authorization",`Bearer ${token}`).send(b);expect(r.status).toBe(i===2?429:200);}
  });
  it("fails closed on database and matcher failure, without payload leaks",async()=>{
    for(const target of ["database","matcher"]) {const f=fixture();if(target==="database")(f.store.lookup as any).mockRejectedValue(new Error("secret postgres://private"));else f.matcher.match.mockRejectedValue(new Error("raw coordinates"));
      const r=await request(f.app).post(`${path}/batches`).set("Authorization",`Bearer ${token}`).send(batch());expect(r.status).toBe(503);expect(JSON.stringify(r.body)).not.toContain("secret");expect(f.store.commit).not.toHaveBeenCalled();}
  });
  it("bounds concurrent matching across distinct contributors",async()=>{
    const {app,matcher}=fixture();const releases:Array<()=>void>=[];
    matcher.match.mockImplementation(()=>new Promise(resolve=>releases.push(()=>resolve(match()))));
    const pending=[0,1,2,3].map(i=>{const b=batch();b.batchId=`00000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`;b.contributorIdDay=String(i).repeat(40);
      return request(app).post(`${path}/batches`).set("Authorization",`Bearer ${token}`).send(b).then(r=>r);});
    try {
      await vi.waitFor(()=>expect(matcher.match).toHaveBeenCalledTimes(4));
      const b=batch();b.batchId="00000000-0000-4000-8000-000000000005";b.contributorIdDay="z".repeat(40);
      const r=await request(app).post(`${path}/batches`).set("Authorization",`Bearer ${token}`).send(b);
      expect(r.status).toBe(429);expect(r.body.error.code).toBe("DRIVER_INTAKE_BUSY");expect(r.headers["retry-after"]).toBe("15");
    }finally{releases.forEach(release=>release());await Promise.all(pending);}
  });
  it("returns only shadow aggregates and self-report quality, rejects arbitrary filters",async()=>{const {app}=fixture();
    const r=await request(app).get(`${path}/aggregates`).set("Authorization",`Bearer ${token}`);expect(r.body.applicationMode).toBe("shadow_only");expect(r.body.limits.minimumAttestedContributors).toBe(5);
    expect((await request(app).get(`${path}/quality`).set("Authorization",`Bearer ${token}`)).body.etaEvidence).toBe("client_reported_not_ground_truth");
    expect((await request(app).get(`${path}/aggregates?userId=person`).set("Authorization",`Bearer ${token}`)).status).toBe(400);
  });
  it("revocation prevents queued retransmission",async()=>{const {app}=fixture();
    const r=await request(app).delete(`${path}/contributions`).set("Authorization",`Bearer ${token}`).send({contractVersion:DRIVER_CONTRACT,contributorIdDay:batch().contributorIdDay});expect(r.status).toBe(200);
    expect((await request(app).post(`${path}/batches`).set("Authorization",`Bearer ${token}`).send(batch())).status).toBe(403);
  });
  it("never map-matches estimated trace points",async()=>{const {app,matcher}=fixture(),b=batch();b.points[1].positionSource="estimated";
    const r=await request(app).post(`${path}/batches`).set("Authorization",`Bearer ${token}`).send(b);expect(r.status).toBe(200);expect(r.body.acceptedIntervalCount).toBe(0);expect(matcher.match).not.toHaveBeenCalled();});
});

describe("Valhalla driver matcher",()=>{
  it("uses POST map_snap, preserves partial-edge length and point alignment",async()=>{
    const original=globalThis.fetch;const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({tileset_last_modified:1790679143})))
      .mockResolvedValueOnce(new Response(JSON.stringify({edges:[{id:8,length:.1,source_percent_along:.1,target_percent_along:.3}],
        matched_points:[.1,.2,.3].map(f=>({type:"matched",edge_index:0,distance_along_edge:f,distance_from_trace_point:2}))})))
      .mockResolvedValueOnce(new Response(JSON.stringify({tileset_last_modified:1790679143})));
    try {globalThis.fetch=fetch;const result=await new ValhallaDriverMatcher("http://synthetic.test").match(batch().points);
      expect(result.points[0]?.edgeLengthM).toBeCloseTo(500);expect(deriveDriverIntervals(batch(),result).intervals).toHaveLength(2);
      const options=fetch.mock.calls[1]?.[1];expect(options.method).toBe("POST");expect(JSON.parse(options.body).shape_match).toBe("map_snap");
    }finally{globalThis.fetch=original;}
  });
  it("fences graph rotation and bounds failing upstream",async()=>{
    const original=globalThis.fetch;try {
      globalThis.fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({tileset_last_modified:1790679143})))
        .mockResolvedValueOnce(new Response(JSON.stringify({edges:[],matched_points:[]})))
        .mockResolvedValueOnce(new Response(JSON.stringify({tileset_last_modified:1790679144})));
      await expect(new ValhallaDriverMatcher("http://synthetic.test").match(batch().points)).rejects.toThrow("DRIVER_MATCH_UNAVAILABLE");
    } finally {globalThis.fetch=original;}
  });
});
