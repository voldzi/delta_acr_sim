import {afterEach,describe,expect,it,vi} from "vitest";
import {BudgetStore} from "./budget.js";
import {EventEmitter} from "node:events";
afterEach(()=>vi.restoreAllMocks());
describe("idle PostgreSQL disconnect",()=>{
 it("also survives checked-out client error without exposing details or making failed queries succeed",async()=>{
  const log=vi.spyOn(console,"error").mockImplementation(()=>{});
  const store=new BudgetStore("postgresql://synthetic:private@127.0.0.1:1/synthetic","synthetic-secret",{dailyMicrousd:1,monthlyMicrousd:2,perUserDailyRequests:1});
  try{
   const client=new EventEmitter();store.pool.emit("connect",client);
   expect(()=>client.emit("error",new Error("private-held-client-detail"))).not.toThrow();
   expect(log).toHaveBeenCalledExactlyOnceWith('{"event":"ai_router_database_client_connection_error"}');
   expect(JSON.stringify(log.mock.calls)).not.toContain("private-held-client-detail");
   vi.spyOn(store.pool,"query").mockRejectedValue(new Error("synthetic-closed-client"));
   await expect(store.policy()).rejects.toThrow("synthetic-closed-client");
  }finally{await store.close();}
 });
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
