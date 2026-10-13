import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDriverMeasurementStore } from "../src/driver-measurement-store.js";

const mock=vi.hoisted(()=>({query:vi.fn(),release:vi.fn(),connect:vi.fn(),poolQuery:vi.fn(),end:vi.fn(),on:vi.fn()}));
vi.mock("pg",()=>({Pool:vi.fn(function(){return {query:mock.poolQuery,connect:mock.connect,end:mock.end,on:mock.on};})}));
const dataset="sim-routing-2026-10-11-1791687606", now="2026-10-13T12:03:00.000Z";
const emptyTotals={retainedBatchCount:0,lastAcceptedAt:null,acceptedIntervalCount:0,deduplicatedIntervalCount:0,
  activeRevocationTombstoneCount:0,rejectionCounts:{}};
const emptyCounts={evaluatedGroupCount:0,currentGroupCount:0,historicalGroupCount:0,futureGroupCount:0,
  otherDatasetGroupCount:0,subthresholdGroupCount:0,qualityGroupCount:0,closedWindowGroupCount:0,
  currentQualityGroupCount:0,currentQualityIntervalCount:0};
let store:PostgresDriverMeasurementStore;
beforeEach(()=>{
  vi.clearAllMocks();
  mock.end.mockResolvedValue(undefined);
  mock.connect.mockResolvedValue({query:mock.query,release:mock.release});
  mock.query.mockImplementation(async(sql:string)=>{
    if(sql.startsWith("WITH retained"))return {rows:[emptyTotals]};
    if(sql.includes('AS "evaluatedGroupCount"'))return {rows:[emptyCounts]};
    return {rows:[]};
  });
  store=new PostgresDriverMeasurementStore("postgresql://synthetic.invalid/isolated","synthetic-storage-secret-".repeat(2));
});
afterEach(async()=>{await store.close();});

describe("driver evaluation database snapshot boundary (synthetic mock only)",()=>{
  it("uses one connection, read-only repeatable read and only bounded aggregate queries",async()=>{
    const result=await store.evaluation(dataset,now);
    expect(mock.query.mock.calls[0][0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(mock.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(mock.connect).toHaveBeenCalledTimes(1);expect(mock.release).toHaveBeenCalledTimes(1);
    expect(result.summary.eta).toEqual([]);expect(result.summary.lastAcceptedAt).toBeNull();
    const sql=mock.query.mock.calls.map(call=>call[0] as string).join("\n");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
    expect(sql).toContain("GROUP BY i.dataset,i.edge_id,i.window_start,r.contributor_hash");
    expect(sql).toContain("HAVING count(*)>=5 AND sum(n)>=10");expect(sql).toContain("LIMIT 100");
    expect(mock.query.mock.calls[2][1]).toEqual([dataset,"2026-10-12T12:03:00.000Z",now]);
  });
  it("does not return partial results or raw database errors when a snapshot query fails",async()=>{
    const failure=new Error("synthetic database detail");
    mock.query.mockImplementation(async(sql:string)=>{
      if(sql.startsWith("WITH retained"))return {rows:[emptyTotals]};
      if(sql.includes('AS "evaluatedGroupCount"'))throw failure;
      return {rows:[]};
    });
    await expect(store.evaluation(dataset,now)).rejects.toBe(failure);
    expect(mock.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");expect(mock.release).toHaveBeenCalledTimes(1);
    expect(mock.query.mock.calls.some(call=>call[0]==="COMMIT")).toBe(false);
  });
  it("fails closed on corrupted stored rejection metadata and rolls back",async()=>{
    mock.query.mockImplementation(async(sql:string)=>{
      if(sql.startsWith("WITH retained"))return {rows:[{...emptyTotals,rejectionCounts:{private_user_field:1}}]};
      if(sql.includes('AS "evaluatedGroupCount"'))return {rows:[emptyCounts]};
      return {rows:[]};
    });
    await expect(store.evaluation(dataset,now)).rejects.toThrow("Invalid driver evaluation snapshot");
    expect(mock.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");expect(mock.release).toHaveBeenCalledTimes(1);
  });
  it("does not query the database for an invalid evaluation graph or clock",async()=>{
    await expect(store.evaluation("unknown",now)).rejects.toThrow();
    await expect(store.evaluation(dataset,"2026-02-30T12:00:00Z")).rejects.toThrow();
    expect(mock.connect).not.toHaveBeenCalled();
  });
  it("keeps the legacy five-minute end and excludes future windows from aggregates",async()=>{
    mock.poolQuery.mockResolvedValue({rows:[]});
    await store.aggregates(dataset,"2026-10-13T11:00:00.000Z",now);
    const sql=mock.poolQuery.mock.calls[0][0] as string;
    expect(sql).toContain("i.window_start<=$3");expect(sql).toContain("r.expires_at>$3");
    expect(sql).toContain("window_start+interval '5 minutes'");
    expect(sql).not.toContain("observed_at");
  });
});
