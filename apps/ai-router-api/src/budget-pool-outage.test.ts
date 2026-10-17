import {afterEach,describe,expect,it,vi} from "vitest";
import {BudgetStore} from "./budget.js";
afterEach(()=>vi.restoreAllMocks());
describe("idle PostgreSQL disconnect",()=>{
 it("does not crash or expose error details",async()=>{
  const log=vi.spyOn(console,"error").mockImplementation(()=>{});
  const store=new BudgetStore("postgresql://synthetic:private@127.0.0.1:1/synthetic","synthetic-secret",{dailyMicrousd:1,monthlyMicrousd:2,perUserDailyRequests:1});
  try{
   expect(()=>store.pool.emit("error",new Error("private-connection-query-detail"))).not.toThrow();
   expect(log).toHaveBeenCalledExactlyOnceWith('{"event":"ai_router_database_idle_connection_error"}');
   expect(JSON.stringify(log.mock.calls)).not.toContain("private-connection-query-detail");
  }finally{await store.close();}
 });
 it("does not turn failed database queries into successful policy reads",async()=>{
  vi.spyOn(console,"error").mockImplementation(()=>{});
  const store=new BudgetStore("postgresql://synthetic:private@127.0.0.1:1/synthetic","synthetic-secret",{dailyMicrousd:1,monthlyMicrousd:2,perUserDailyRequests:1});
  try{
   store.pool.emit("error",new Error("synthetic-disconnect"));
   vi.spyOn(store.pool,"query").mockRejectedValue(new Error("synthetic-db-down"));
   await expect(store.policy()).rejects.toThrow("synthetic-db-down");
  }finally{await store.close();}
 });
});
