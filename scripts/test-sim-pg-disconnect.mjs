/** Synthetic EventEmitter/pg doubles + actual unchanged authority and ledger.
 * No PostgreSQL, network, credentials, roles or production data are used. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { attachSimPgErrorObservers } from '../packages/sim-user-data/pg-errors.mjs';
import { createSimUserDataAuthority } from '../packages/sim-user-data/authority.mjs';
import { UserLedger } from '../packages/sim-user-data/ledger.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const failure = () => Object.assign(new Error('SYNTHETIC PRIVATE QUERY OR CONNECTION DETAIL'), {code:'57P01'});
const binding = Object.fromEntries(['guard_store_id','target_store_id','incarnation_id','environment_id','reset_epoch','checkpoint_id'].map((k,i)=>[k,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
Object.assign(binding,{restore_generation:'1',source_sha256:'a'.repeat(64),identity_sha256:'b'.repeat(64)});
const settings={mode:'production-sim-user-data-v1',environmentId:binding.environment_id,resetEpoch:binding.reset_epoch,tokensNotBefore:1};
async function fixture() {
  const records=[],state={quarantine:false,configBad:false,disconnect:undefined,commits:0,work:0,verifies:0,serverCommitUncertain:false};
  class Pool extends EventEmitter {
    constructor(lane){super();this.lane=lane;attachSimPgErrorObservers(this,lane,r=>records.push(r));}
    async connect(){const c=new EventEmitter();c.release=()=>{};c.query=async(sql)=>{
      if(c.broken)throw failure();
      if(state.disconnect===this.lane&&sql==='COMMIT'){
        if(this.lane==='target'){state.commits++;state.serverCommitUncertain=true;}
        c.broken=true;c.emit('error',failure());throw failure();
      }
      if(sql==='COMMIT'&&this.lane==='target')state.commits++;
      return this.query(sql);
    };this.emit('connect',c);return c;}
    async query(sql){
      if(state.disconnect===this.lane&&sql.includes('SYNTHETIC_BUSY')){const c=await this.connect();c.broken=true;c.emit('error',failure());throw failure();}
      if(sql.includes('FROM pg_roles'))return {rows:[{name:this.lane==='guard'?'sim_user_data_guard_runtime':'sim_user_data_runtime',elevated:false}]};
      if(sql.startsWith('SELECT current_database() db,* FROM sim_erasure_guard'))return {rows:[{...binding,db:'cop_account_safety_guard',contract:'sim-user-continuity-v1',state:state.quarantine?'quarantined':'ready'}]};
      if(sql.includes('.continuity WHERE singleton')){state.verifies++;return {rows:[{...binding,db:'sim_user_data',contract:'sim-user-continuity-v1'}]};}
      if(sql.includes('.config WHERE singleton'))return {rows:[{...settings,contract:'cop-sim-user-data-v1',environment_id:settings.environmentId,reset_epoch:state.configBad?'changed':settings.resetEpoch,tokens_not_before:1}]};
      if(sql.includes('user_data_tombstone'))return {rows:[]};
      return {rows:[]};
    }
  }
  const target=new Pool('target'),guard=new Pool('guard');
  const authority=await createSimUserDataAuthority({guardPool:guard,targetPool:target,component:'sim_user_data',binding});
  const ledger=new UserLedger(target,settings,'sim_user_data',authority);
  return {state,records,target,guard,authority,ledger};
}
for(const lane of ['target','guard']){
  test(lane+': idle and checked-out client error do not kill process or expose details',async()=>{
    const f=await fixture();const p=f[lane],c=await p.connect();
    assert.doesNotThrow(()=>p.emit('error',failure()));
    assert.doesNotThrow(()=>c.emit('error',failure()));
    assert(f.records.some(r=>r.pool===lane&&r.kind==='client'&&r.sqlstate==='57P01'));
    assert(!JSON.stringify(f.records).includes('PRIVATE'));
  });
  test(lane+': busy query rejects, and a fresh admission revalidates after recovery',async()=>{
    const f=await fixture();f.state.disconnect=lane;
    await assert.rejects(()=>f[lane].query('SELECT SYNTHETIC_BUSY'));
    f.state.disconnect=undefined;const before=f.state.verifies;
    await f.ledger.tx(async()=>{});assert(f.state.verifies>before);
  });
  test(lane+': disconnect at COMMIT propagates once, without replaying work',async()=>{
    const f=await fixture();f.state.disconnect=lane;
    await assert.rejects(()=>f.ledger.tx(async()=>{f.state.work++}));
    assert.equal(f.state.work,1);assert.equal(f.state.commits,1);
    if(lane==='target')assert.equal(f.state.serverCommitUncertain,true);
    // A guard failure may follow a successful target commit too. Neither path
    // is permission to replay the business operation or claim rollback worked.
    assert(f.records.some(r=>r.pool===lane&&r.kind==='client'));
  });
  test(lane+': an installed observer does not bypass quarantine/config mismatch',async()=>{
    const f=await fixture();f.state.quarantine=true;
    await assert.rejects(()=>f.ledger.tx(async()=>{f.state.work++}));assert.equal(f.state.work,0);
    f.state.quarantine=false;f.state.configBad=true;
    await assert.rejects(()=>f.ledger.tx(async()=>{f.state.work++}));assert.equal(f.state.work,0);
  });
}
test('observer attaches once, masks unknown SQLSTATE, tolerates diagnostic sink failure',()=>{
  const p=new EventEmitter(),records=[];
  attachSimPgErrorObservers(p,'target',r=>records.push(r));attachSimPgErrorObservers(p,'target');
  assert.equal(p.listenerCount('connect'),1);assert.equal(p.listenerCount('error'),1);
  p.emit('error',{code:'secret-person',message:'private'});assert.equal(records[0].sqlstate,'OTHER');
  const q=new EventEmitter();attachSimPgErrorObservers(q,'guard',()=>{throw failure()});
  assert.doesNotThrow(()=>q.emit('error',failure()));
});
test('authority factory and ledger controlled sources are unchanged',async()=>{
  for(const [file,sha] of [['authority.mjs','a0b3fd882baff5ee24401af035ff99134b8ea1f5cc362c88c909cb9bd67ad3d2'],['ledger.mjs','61a4dc6d62b45819274a271fdb36c90c92a6fa724e121af7a72c8db96481603b']]){
    assert.equal(createHash('sha256').update(await readFile(new URL('../packages/sim-user-data/'+file,import.meta.url))).digest('hex'),sha);
  }
});
