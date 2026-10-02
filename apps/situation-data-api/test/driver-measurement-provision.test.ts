import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script=fileURLToPath(new URL("../../../scripts/provision-driver-measurements-postgres.sh",import.meta.url));
const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function run(args:string[], extra:Record<string,string>={}) {
  const dir=mkdtempSync(join(tmpdir(),"sim-driver-provision-")); directories.push(dir);
  // Never contacts PostgreSQL: fail any command other than the two read-only checks.
  writeFileSync(join(dir,"psql"),`#!/bin/sh\ncase "$*" in\n *rolsuper*) printf '%s\\n' "\${TEST_SUPERUSER:-t}";;\n *'count(*)'*) printf '%s\\n' "\${TEST_OBJECT_COUNT:-0}";;\n *) echo unexpected-write >&2; exit 98;;\nesac\n`,{mode:0o700});
  const result=spawnSync("/bin/bash",[script,...args],{encoding:"utf8",env:{...process.env,
    PATH:`${dir}:/usr/bin:/bin`,PGUSER:"postgres",PGPASSWORD:"synthetic-not-a-secret",
    PGHOST:"haproxy.home.cz",PGPORT:"5000",...extra}});
  return {code:result.status,output:result.stdout+result.stderr};
}
describe("driver database provisioning preflight (mocked, no cluster writes)",()=>{
  it("checks the fixed HAProxy endpoint without mutation or secret output",()=>{
    const result=run(["--check"]);expect(result.code).toBe(0);expect(result.output).toContain("0/3");
    expect(result.output).not.toContain("synthetic-not-a-secret");
  });
  it("reports existing isolated objects read-only",()=>{
    const result=run(["--check"],{TEST_OBJECT_COUNT:"3"});expect(result.code).toBe(0);expect(result.output).toContain("3/3");
  });
  it("rejects a different endpoint before PostgreSQL",()=>{
    expect(run(["--check"],{PGHOST:"other.example"}).code).toBe(2);
    expect(run(["--check"],{PGPORT:"5432"}).code).toBe(2);
  });
  it("requires administrator and explicit mode",()=>{
    expect(run(["--check"],{TEST_SUPERUSER:"f"}).code).toBe(1);
    expect(run([]).code).toBe(2);expect(run(["--drop"]).code).toBe(2);
  });
  it("refuses apply on existing roles/database before confirmation or password rotation",()=>{
    const result=run(["--apply"],{TEST_OBJECT_COUNT:"3",DRIVER_MEASUREMENTS_CREDENTIALS_FILE:"/nonexistent-synthetic-path/creds.env"});
    expect(result.code).toBe(1);expect(result.output).toContain("no changes made");
  });
});
