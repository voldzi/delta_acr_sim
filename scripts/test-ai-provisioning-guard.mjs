/** Offline CLI control-flow only. Every psql/openssl call is intercepted.
 * No actual PostgreSQL, credential rotation, Root record, network or deploy.
 * Main reviews this new source and owns its execution. */
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {chmod,mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {existsSync,realpathSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

const repo=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const script=join(repo,"scripts/provision-ai-router-postgres.sh"),parent=realpathSync("/private/tmp");
const root=await mkdtemp(join(parent,"sim-ai-provision-mock-"));await chmod(root,0o700);
const log=join(root,"queries.jsonl"),cryptoLog=join(root,"openssl.log"),credentials=join(root,"never-created.env");
const execute=promisify(execFile),checks=[];
const mock="#!/usr/bin/env node\n"+
 'const {appendFileSync}=require("node:fs");\n'+
 'const args=process.argv.slice(2),sql=args[args.indexOf("-c")+1];\n'+
 'appendFileSync(process.env.SIM_TEST_QUERY_LOG,JSON.stringify(args)+"\\n");\n'+
 'if(sql?.startsWith("SELECT rolsuper")){console.log("t");process.exit(0);}\n'+
 'if(sql?.includes("count(*) FROM pg_roles")){console.log(process.env.SIM_TEST_EXISTING);process.exit(0);}\n'+
 'if(sql==="SELECT to_regnamespace(\'sim_ai_guard_source\') IS NOT NULL"){\n'+
 ' if(process.env.SIM_TEST_GUARDED==="error"){console.error("synthetic probe failure");process.exit(73);}\n'+
 ' console.log(process.env.SIM_TEST_GUARDED);process.exit(0);}\n'+
 'console.error("Unexpected SQL in offline mock");process.exit(90);\n';
const openssl="#!/usr/bin/env node\n"+
 'require("node:fs").appendFileSync(process.env.SIM_TEST_CRYPTO_LOG,"unexpected credential generation\\n");process.exit(91);\n';
await writeFile(join(root,"psql"),mock,{mode:0o700,flag:"wx"});
await writeFile(join(root,"openssl"),openssl,{mode:0o700,flag:"wx"});
try{
 for(const [name,mode,existing,guarded,code] of [
  ["guarded recover cannot rotate credentials or replay legacy grants","--recover","3","t",1],
  ["guarded apply cannot write credentials or regrant legacy schema","--apply","3","t",1],
  ["guarded check is detection only, never readiness or Root verification","--check","3","t",0],
  ["legacy check keeps its read-only compatibility path","--check","3","f",0],
  ["unavailable target namespace probe fails closed before recovery","--recover","3","error",1],
  ["nonboolean namespace diagnostic cannot authorize legacy recovery","--recover","3","unexpected",1],
  ["partial-object check does not attempt a possibly absent target database","--check","2","t",0],
  ["empty-object check does not attempt target inspection or provisioning","--check","0","t",0],
 ]){
  await writeFile(log,"",{mode:0o600});
  const env={PATH:root+":"+dirname(process.execPath)+":"+(process.env.PATH??"/usr/bin:/bin"),HOME:root,
   PGUSER:"synthetic_admin",PGPASSWORD:"synthetic-never-used-password",AI_ROUTER_DB_CREDENTIALS_FILE:credentials,
   SIM_TEST_QUERY_LOG:log,SIM_TEST_CRYPTO_LOG:cryptoLog,SIM_TEST_EXISTING:existing,SIM_TEST_GUARDED:guarded};
  let result;try{result={...(await execute("/bin/bash",[script,mode],{env,timeout:5000})),code:0};}catch(error){result=error;}
  assert.equal(result.code,code,name);assert.equal(existsSync(credentials),false,"No credentials file may be written");
  assert.equal(existsSync(cryptoLog),false,"Credential generation must never be reached");
  const calls=(await readFile(log,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
  assert.equal(calls.length,existing==="3"?3:2,name);
  for(const [i,args] of calls.entries()){
   assert.equal(args[args.indexOf("-h")+1],"haproxy.home.cz");assert.equal(args[args.indexOf("-p")+1],"5000");
   assert.equal(args[args.indexOf("-U")+1],"synthetic_admin");assert.equal(args[args.indexOf("-d")+1],i===2?"sim_ai_router":"postgres");
   assert.ok(args.includes("-X")&&args.includes("-c")&&!args.includes("-f"));
   const sql=args[args.indexOf("-c")+1];assert.match(sql,/^SELECT /u);
   assert.doesNotMatch(sql,/\b(?:CREATE|ALTER|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE)\b/iu);
   if(i===2)assert.equal(sql,"SELECT to_regnamespace('sim_ai_guard_source') IS NOT NULL");
  }
  const output=String(result.stdout??"")+String(result.stderr??"");assert.ok(!output.includes(env.PGPASSWORD));
  if(guarded==="t"&&mode==="--check"&&existing==="3")assert.match(result.stdout,/not runtime privilege verification, restore\/Root readiness or activation/u);
  if(guarded==="t"&&mode!=="--check")assert.match(result.stderr,/refusing legacy provisioning\/recovery/u);
  checks.push({name,passed:true});
 }
 console.log(JSON.stringify({scope:"offline_psql_openssl_interception_only",passed:checks.length,checks,
  realDatabaseCalls:0,credentialsGenerated:false,credentialsWritten:false,productionChanged:false,rootAuthority:false}));
}finally{
 assert.equal(dirname(realpathSync(root)),parent);assert.equal((await stat(root)).uid,process.getuid());
 assert.equal((await stat(root)).mode&0o777,0o700);await rm(root,{recursive:true});
}
