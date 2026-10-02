// Host-owner operation only. Runtime DB URL on stdin, never returned on stdout.
import {readFileSync,writeFileSync,renameSync,statSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
try {
const revision=process.argv[2];
if(!/^[a-f0-9]{40}$/.test(revision??''))throw new Error('Exact reviewed revision required');
const url=readFileSync(0,'utf8').trim(), db=new URL(url);
if(db.protocol!=='postgresql:' || db.hostname!=='haproxy.home.cz' || db.port!=='5000' || db.pathname!=='/sim_driver_measurements' || db.username!=='driver_measurements_runtime' || !db.password || /[\r\n]/.test(url))throw new Error('Unexpected dedicated runtime database');
function load(path){
  if((statSync(path).mode&0o777)!==0o600)throw new Error('Production secrets must be mode 600');
  const text=readFileSync(path,'utf8'), values=new Map();
  for(const line of text.split('\n')){const m=line.match(/^([A-Z0-9_]+)=(.*)$/);if(m){if(values.has(m[1]))throw new Error('Duplicate environment key');values.set(m[1],m[2]);}}
  return {path,text,values};
}
const sim=load('/srv/sim/.env'),cop=load('/srv/cop/.env');
const st=sim.values.get('DRIVER_MEASUREMENTS_COP_TOKEN'),ct=cop.values.get('COP_DRIVER_MEASUREMENTS_SIM_TOKEN');
if(st && ct && st!==ct)throw new Error('Conflicting tokens; no rotation');
const token=st||ct||randomBytes(32).toString('hex');
if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Unexpected existing token format');
const ss=sim.values.get('DRIVER_MEASUREMENTS_HASH_SECRET')||randomBytes(32).toString('hex');
const cs=cop.values.get('COP_DRIVER_MEASUREMENTS_HASH_SECRET')||randomBytes(32).toString('hex');
if(ss.length<32 || cs.length<32)throw new Error('Unexpected HMAC secret');
const files=(sim.values.get('COMPOSE_FILE')||'docker-compose.yml:docker-compose.x5.yml').split(':');
if(!files.includes('docker-compose.driver-measurements.yml'))files.push('docker-compose.driver-measurements.yml');
function save(state,updates){
  const keys=new Set(Object.keys(updates));
  const body=state.text.split('\n').filter(line=>!keys.has(line.split('=',1)[0])).join('\n').trimEnd()+'\n'+Object.entries(updates).map(([k,v])=>`${k}=${v}`).join('\n')+'\n';
  const backup=`${state.path}.before-driver-measurements-${revision.slice(0,12)}`;
  try{statSync(backup);}catch{writeFileSync(backup,state.text,{mode:0o600,flag:'wx'});}
  const temporary=`${state.path}.driver-measurements.tmp`;
  writeFileSync(temporary,body,{mode:0o600,flag:'wx'});renameSync(temporary,state.path);
}
save(sim,{DRIVER_MEASUREMENTS_ENABLED:'false',DRIVER_MEASUREMENTS_REVOCATION_ENABLED:'true',DRIVER_MEASUREMENTS_DATABASE_URL:url,
  DRIVER_MEASUREMENTS_COP_TOKEN:token,DRIVER_MEASUREMENTS_HASH_SECRET:ss,DRIVER_MEASUREMENTS_RATE_PER_MINUTE:'120',
  DRIVER_MEASUREMENTS_IMAGE:`sim-situation-data-api:driver-${revision}`,COMPOSE_FILE:files.join(':')});
save(cop,{COP_DRIVER_MEASUREMENTS_ENABLED:'false',COP_DRIVER_MEASUREMENTS_CLEANUP_ENABLED:'true',
  COP_DRIVER_MEASUREMENTS_SIM_URL:'http://sim-driver-measurements:4020/api/v1/internal/driver-measurements/v1',
  COP_DRIVER_MEASUREMENTS_SIM_TOKEN:token,COP_DRIVER_MEASUREMENTS_HASH_SECRET:cs});
const old=spawnSync('crontab',['-l'],{encoding:'utf8'});
if(old.error || (old.status!==0 && !/no crontab/i.test(old.stderr)))throw new Error('Cannot read existing user cron');
const cron=(old.stdout||'').split('\n').filter(x=>!x.includes('# csm-sim-driver-retention')).join('\n').trimEnd()+
  '\n*/15 * * * * /bin/sh /srv/sim/scripts/cleanup-driver-measurements-production.sh >> /srv/sim/data/driver-retention.log 2>&1 # csm-sim-driver-retention\n';
if(spawnSync('crontab',['-'],{input:cron,encoding:'utf8'}).status!==0)throw new Error('Cannot install retention cron');
console.log('Production secrets configured privately; intake disabled, revocation enabled.');
} catch { console.error('Production measurement configuration failed; inspect privately. No credentials printed.');process.exitCode=1; }
