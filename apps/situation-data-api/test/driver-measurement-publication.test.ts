import { mkdtemp, readFile, chmod, stat, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectDriverEvaluationSnapshot } from "../src/driver-measurement-evaluation.js";
import { DriverEvaluationPublisher, projectDriverEvaluationReport, removeDriverEvaluationReport, validateDriverEvaluationReportPath,
  writeDriverEvaluationReport, type DriverEvaluationReport } from "../src/driver-measurement-publication.js";

const dataset="sim-routing-2026-10-11-1791687606", now="2026-10-13T12:03:00.000Z";
export function report(count=0):DriverEvaluationReport {
  return {...projectDriverEvaluationSnapshot(dataset,now,{retainedBatchCount:count,lastAcceptedAt:null,acceptedIntervalCount:count,
    deduplicatedIntervalCount:0,activeRevocationTombstoneCount:0,rejectionCounts:{}},
    {evaluatedGroupCount:0,currentGroupCount:0,historicalGroupCount:0,futureGroupCount:0,otherDatasetGroupCount:0,
      subthresholdGroupCount:0,qualityGroupCount:0,closedWindowGroupCount:0,currentQualityGroupCount:0,currentQualityIntervalCount:0},[]),
    intake:{enabled:true,revocationEnabled:true,accountScope:"cop_managed_with_consent"},comparisonMode:"disabled",liveAppliedGroupCount:0};
}
const directories:string[]=[];
async function path():Promise<string> {const dir=await mkdtemp(join(tmpdir(),"driver-evaluation-test-"));directories.push(dir);return join(dir,"latest.json");}
afterEach(async()=>{await Promise.all(directories.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});

describe("private driver evaluation publication",()=>{
  it("reconstructs only the exact scalar contract and rejects raw additions recursively",()=>{
    expect(projectDriverEvaluationReport(report())).toEqual(report());
    for(const change of [(r:any)=>r.points=[{lat:50,lon:14}],(r:any)=>r.summary.rawGPS="private",
      (r:any)=>r.summary.speed.edgeId="8",(r:any)=>r.intake.userId="private",(r:any)=>r.liveAppliedGroupCount=1,
      (r:any)=>r.retentionDays=30,(r:any)=>r.summary.rejectionCounts.personal_note=1]) {
      const r=report();change(r);expect(()=>projectDriverEvaluationReport(r)).toThrow();
    }
  });
  it("allows only a normalized absolute latest.json destination",()=>{
    for(const invalid of ["latest.json","/tmp/../latest.json","/tmp/private.json","/tmp/latest.json\0"])
      expect(()=>validateDriverEvaluationReportPath(invalid)).toThrow();
  });
  it("writes atomically with private file permissions, without raw identifiers",async()=>{
    const file=await path();await writeDriverEvaluationReport(file,report(1));await writeDriverEvaluationReport(file,report(2));
    expect(JSON.parse(await readFile(file,"utf8"))).toEqual(report(2));expect((await stat(file)).mode&0o777).toBe(0o600);
    for(const raw of ['"lat"','"lon"','"points"','"contributorIdDay"','"batchId"','"directedEdgeId"']) expect(await readFile(file,"utf8")).not.toContain(raw);
  });
  it("refuses symlinks or group-writable parents and does not modify their target",async()=>{
    const file=await path(), target=join(file,"..","target.json");await writeFile(target,"unrelated",{mode:0o600});await symlink(target,file);
    await expect(writeDriverEvaluationReport(file,report())).rejects.toThrow("DRIVER_EVALUATION_PUBLICATION_UNAVAILABLE");
    await expect(removeDriverEvaluationReport(file)).rejects.toThrow("DRIVER_EVALUATION_PUBLICATION_UNAVAILABLE");
    expect(await readFile(target,"utf8")).toBe("unrelated");await rm(file);await chmod(join(file,".."),0o770);
    await expect(writeDriverEvaluationReport(file,report())).rejects.toThrow("DRIVER_EVALUATION_PUBLICATION_UNAVAILABLE");
  });
  it("coalesces readers and discards a snapshot read before completed revocation",async()=>{
    const file=await path();let release!:(r:DriverEvaluationReport)=>void;
    const load=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;})).mockResolvedValue(report());
    const publisher=new DriverEvaluationPublisher(file,load), before=publisher.refresh();
    expect(publisher.refresh()).toBe(before);const deletion=publisher.afterRevocation();release(report(1));await deletion;await before;
    expect(load).toHaveBeenCalledTimes(3);expect(JSON.parse(await readFile(file,"utf8")).summary.retainedBatchCount).toBe(0);await publisher.close();
  });
  it("removes a formerly fresh report if post-revocation loading fails, never reporting completion",async()=>{
    const file=await path();await writeDriverEvaluationReport(file,report(1));
    const publisher=new DriverEvaluationPublisher(file,vi.fn().mockRejectedValue(new Error("private DB detail")));
    await expect(publisher.afterRevocation()).rejects.toThrow("DRIVER_EVALUATION_PUBLICATION_UNAVAILABLE");
    await expect(readFile(file)).rejects.toMatchObject({code:"ENOENT"});await publisher.close();
  });
  it("closing during a pending read never writes the snapshot afterwards",async()=>{
    const file=await path();let release!:(r:DriverEvaluationReport)=>void;
    const publisher=new DriverEvaluationPublisher(file,()=>new Promise(resolve=>{release=resolve;}));
    const pending=publisher.refresh(), closing=publisher.close();release(report(1));await pending;await closing;
    await expect(readFile(file)).rejects.toMatchObject({code:"ENOENT"});
  });
  it("a closed publisher cannot acknowledge a refreshed deletion",async()=>{
    const file=await path();await writeDriverEvaluationReport(file,report(1));
    const publisher=new DriverEvaluationPublisher(file,async()=>report());await publisher.close();
    await expect(publisher.afterRevocation()).rejects.toThrow("DRIVER_EVALUATION_PUBLICATION_UNAVAILABLE");
    await expect(readFile(file)).rejects.toMatchObject({code:"ENOENT"});
  });
});
