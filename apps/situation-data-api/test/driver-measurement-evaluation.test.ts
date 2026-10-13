import { describe, expect, it } from "vitest";
import { driverEvaluationInputs, isDriverEvaluationSnapshotFresh, projectDriverEvaluationSnapshot } from "../src/driver-measurement-evaluation.js";

const dataset="sim-routing-2026-10-11-1791687606", now="2026-10-13T12:03:00.000Z";
const totals=()=>({retainedBatchCount:0,lastAcceptedAt:null,acceptedIntervalCount:0,deduplicatedIntervalCount:0,
  activeRevocationTombstoneCount:0,rejectionCounts:{}});
const counts=()=>({evaluatedGroupCount:0,currentGroupCount:0,historicalGroupCount:0,futureGroupCount:0,
  otherDatasetGroupCount:0,subthresholdGroupCount:0,qualityGroupCount:0,closedWindowGroupCount:0,
  currentQualityGroupCount:0,currentQualityIntervalCount:0});
const eta=()=>({routingDataset:dataset,windowStart:"2026-10-13T12:00:00.000Z",attestedContributorCount:5,
  observationCount:10,medianAbsoluteErrorSeconds:20,medianAbsoluteErrorPercent:20});

describe("driver measurement scalar evaluation",()=>{
  it("returns empty ETA, null last receipt and exact last-24-hour window without live authorization",()=>{
    const result=projectDriverEvaluationSnapshot(dataset,now,totals(),counts(),[]);
    expect(result).toMatchObject({contractVersion:"sim-driver-evaluation-v1",generatedAt:now,asOf:now,routingDataset:dataset,
      evaluationWindow:{since:"2026-10-12T12:03:00.000Z",until:now},applicationMode:"shadow_only",
      consistency:"read_only_repeatable_read",livePromotionSupported:false,revocationCoverage:"database_only",
      summary:{lastAcceptedAt:null,eta:[]},limits:{minimumAttestedContributors:5,minimumIntervals:10,maximumEtaRows:100}});
    expect(Object.values(result.summary.rejectionCounts)).toEqual(Array(8).fill(0));
  });
  it("copies only scalar DTO fields, never GPS, identities, edge IDs, receipt UUID or arbitrary JSON",()=>{
    const t={...totals(),lat:50,lon:14,points:[{lat:50}],contributor_hash:"private-contributor",batch_id:"private-batch",edge_id:"123456"};
    const c={...counts(),edge_id:"123456",rawGPS:"private-gps"};
    const e={...eta(),contributor_hash:"private-contributor",edge_id:"123456",observation_id:"private-observation"};
    const serialized=JSON.stringify(projectDriverEvaluationSnapshot(dataset,now,t,c,[e]));
    for (const forbidden of ["private-contributor","private-batch","private-gps","private-observation",'"lat"','"lon"','"points"','"edge_id"','"123456"']) expect(serialized).not.toContain(forbidden);
  });
  it("fails closed for an unknown stored rejection key rather than publishing its text",()=>{
    const t={...totals(),rejectionCounts:{private_personal_note:1}};
    expect(()=>projectDriverEvaluationSnapshot(dataset,now,t,counts(),[])).toThrow("Invalid driver evaluation snapshot");
  });
  it("reports dedupe, known rejection counts and closed windows independently of full-edge coverage",()=>{
    const t={...totals(),retainedBatchCount:2,lastAcceptedAt:new Date("2026-10-13T12:02:00Z"),acceptedIntervalCount:12,
      deduplicatedIntervalCount:3,activeRevocationTombstoneCount:1,rejectionCounts:{sampling_gap:2,eta_not_comparable:1}};
    const c={...counts(),evaluatedGroupCount:5,currentGroupCount:2,historicalGroupCount:1,futureGroupCount:1,
      otherDatasetGroupCount:1,subthresholdGroupCount:1,qualityGroupCount:2,closedWindowGroupCount:1,
      currentQualityGroupCount:1,currentQualityIntervalCount:10};
    const result=projectDriverEvaluationSnapshot(dataset,now,t,c,[eta()]);
    expect(result.summary).toMatchObject({deduplicatedIntervalCount:3,activeRevocationTombstoneCount:1,lastAcceptedAt:"2026-10-13T12:02:00.000Z",
      rejectionCounts:{sampling_gap:2,eta_not_comparable:1},speed:c});
    expect(result.etaEvidence).toBe("client_reported_not_ground_truth");
  });
  it("rejects inconsistent group counts and nonfinite or coerced values",()=>{
    for(const change of [(c:any)=>c.currentGroupCount=1,(c:any)=>c.evaluatedGroupCount=-1,
      (c:any)=>c.futureGroupCount="1",(c:any)=>c.currentQualityIntervalCount=NaN,
      (c:any)=>c.closedWindowGroupCount=1,(c:any)=>c.currentQualityIntervalCount=10]) {
      const c=counts();change(c);expect(()=>projectDriverEvaluationSnapshot(dataset,now,totals(),c,[])).toThrow();
    }
    expect(()=>projectDriverEvaluationSnapshot(dataset,now,{...totals(),acceptedIntervalCount:Infinity},counts(),[])).toThrow();
  });
  it("rejects future receipt time, invalid dates, wrong datasets and invalid ETA thresholds",()=>{
    expect(()=>projectDriverEvaluationSnapshot(dataset,now,{...totals(),lastAcceptedAt:"2026-10-13T12:03:01Z"},counts(),[])).toThrow();
    for(const change of [(e:any)=>e.routingDataset="sim-routing-2026-10-12-1",(e:any)=>e.windowStart="2026-10-13T13:00:00Z",
      (e:any)=>e.windowStart="2026-10-11T12:00:00Z",(e:any)=>e.attestedContributorCount=4,
      (e:any)=>e.observationCount=9,(e:any)=>e.medianAbsoluteErrorSeconds=Infinity,
      (e:any)=>e.medianAbsoluteErrorPercent=-1]) {
      const e=eta();change(e);expect(()=>projectDriverEvaluationSnapshot(dataset,now,totals(),counts(),[e])).toThrow();
    }
    expect(()=>driverEvaluationInputs(dataset,"2026-02-30T12:00:00Z")).toThrow();
    expect(()=>driverEvaluationInputs("unversioned-graph",now)).toThrow();
    expect(()=>projectDriverEvaluationSnapshot(dataset,now,totals(),counts(),Array(101).fill(eta()))).toThrow();
  });
  it("marks stale or future snapshot metadata unusable without ever promoting live speeds",()=>{
    const result=projectDriverEvaluationSnapshot(dataset,now,totals(),counts(),[]), time=Date.parse(now);
    expect(isDriverEvaluationSnapshotFresh(result,time+90000)).toBe(true);
    expect(isDriverEvaluationSnapshotFresh(result,time+90001)).toBe(false);
    expect(isDriverEvaluationSnapshotFresh(result,time-1)).toBe(false);
    expect(isDriverEvaluationSnapshotFresh({...result,asOf:"2026-10-13T12:02:00Z"},time)).toBe(false);
    expect(result.livePromotionSupported).toBe(false);
  });
});
