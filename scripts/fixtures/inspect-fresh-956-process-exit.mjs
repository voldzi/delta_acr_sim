/** Read-only sanitized crash classification; never print raw logs or credentials. */
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const {Pool}=createRequire('/runtime/router/apps/ai-router-api/package.json')('pg');
const p=new Pool({host:'/private/tmp/sim-user-install-pg-956262c6abdb/s',port:5000,user:'fixture_admin',database:'sim_ai_router'});
try{const x=(await p.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='ai_router_runtime'")).rows[0];console.log(JSON.stringify({loginAllowed:x.rolcanlogin}));}finally{await p.end()}
const t=await fs.readFile('/dev/shm/cop-clean-whole/resume-router-59fd86c.jsonl','utf8');
const frames=t.split('\n').filter(s=>s.trimStart().startsWith('at ')).map(s=>s.trim()).filter(s=>s.includes('node:')||s.includes('/runtime/')||s.includes('/app/')).slice(-12);
console.log(JSON.stringify({hasEpipe:t.includes('EPIPE'),hasReset:t.includes('ECONNRESET'),hasAdministratorTermination:t.includes('terminating connection due to administrator command'),frames}));
