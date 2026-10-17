"""Exact isolated bundle replacement. Private files travel only server RAM pipe."""
import json,subprocess,sys,time
from pathlib import Path
OLD='31bdf82db465c1de1d0e3fd13a4d2ecfcc02ecfbe668a452dd9cd9876671fca1'
HOLDER='07419d797190ed7bae049c34233e3ec232ed4a712de5b839f0f58554b44f2bb5'
OWNER='cop-clean-whole12-956262c6abdb'
BASE=Path('/srv/x5-production/staging/cop')/OWNER
def docker(*args):return subprocess.check_output(['/usr/bin/docker',*args],stderr=subprocess.PIPE,timeout=60)
def main():
 global OLD
 assert sys.argv[1:] in [['--cutover-only'],['--cutover-checked-client-v2']]
 checked=sys.argv[1:]==['--cutover-checked-client-v2']
 suffix='checked-client-v2' if checked else '59fd86c'
 if checked:OLD='5b0a1a19e5297aa6fd75c97d861fcfe94ab5ae8f1b35ae369664fa4ce8ffd89b'
 before=json.loads(docker('inspect',OLD))[0]
 assert before['Image']==('sha256:739582dea16349b4d42b9c4c4b2250b6de616eaeb803b15a3013b0cc7d0a2118' if checked else 'sha256:923194d92acd6dd176c80bc8a151eb953883f80d3555b87bb45aba9da64833fa')
 assert before['HostConfig']['NetworkMode']=='container:'+HOLDER and before['State']['Running']
 receipt=json.loads((BASE/('router-bundle-'+suffix)/'receipt.json').read_bytes())
 assert receipt['fullTreesIncludingDependencyFilesAndSymlinksEqual'] is True
 assert receipt['routerImage']==('sha256:3fcc09192e451c9a45f839271055e93f7b5250b6e05c6e122223e964ee0247a6' if checked else 'sha256:b6c5698553ca85e006e5af9c14532552ed794890661faa3306ca1c88309f9d73')
 image=receipt['testBundleImage'];assert json.loads(docker('image','inspect',image))[0]['Id']==image
 args=['run','-d','--name',OWNER+'-sim-router-59fd86c','--network','container:'+HOLDER,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000','--label','cop.test.owner='+OWNER,'--tmpfs','/dev/shm:rw,size=64m,uid=1000,gid=1000,mode=0700','--tmpfs','/tmp:rw,size=64m,uid=1000,gid=1000,mode=0700']
 args[args.index('--name')+1]=OWNER+'-sim-router-'+suffix
 for mount in before['HostConfig']['Mounts']:
  source=mount['Source']
  if mount['Target']=='/fixture-clean':source=str(BASE/('router-source-'+suffix))
  args+=['--mount','type=bind,source='+source+',target='+mount['Target']+(',readonly' if mount.get('ReadOnly') else '')]
 args +=[image,'-e','setInterval(()=>{},60000)']
 new=docker(*args).decode().strip()
 # No credentials reach host disk, local machine, argv, environment or logs.
 paths=['cop-clean-whole/'+n for n in ['sim-private.json','sim-resume-private.json','admitted-seed-readback-private.json']]
 send=subprocess.Popen(['/usr/bin/docker','exec',OLD,'tar','-C','/dev/shm','-cf','-',*paths],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 try:
  receive=subprocess.run(['/usr/bin/docker','exec','-i',new,'tar','-C','/dev/shm','-xf','-'],stdin=send.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
  send.stdout.close();assert send.wait(timeout=10)==0 and receive.returncode==0
 finally:
  if send.poll() is None:send.kill();send.wait()
 docker('exec',new,'chmod','0700','/dev/shm/cop-clean-whole')
 stop=r"""const f=require('fs');let ids=[];for(const p of f.readdirSync('/proc')){if(!/^\d+$/.test(p))continue;try{const a=f.readFileSync('/proc/'+p+'/cmdline','utf8').split('\0');if(a[1]?.endsWith('/resume-fresh-956-sim.mjs')&&a[2]==='--resume-existing')ids.push(Number(p));}catch{}}if(ids.length!==1)throw Error('EXACT_SINGLE_OLD_RUNNER_REQUIRED');process.kill(ids[0],'SIGTERM');console.log(JSON.stringify({stoppedExactRunner:true}));"""
 docker('exec',OLD,'node','-e',stop)
 # Prove shared namespace listeners actually closed, not just process dispatch.
 check=r"""(async()=>{for(let i=0;i<30;i++){let n=0;for(const p of[4311,4312,4314,4321,4322,4324])try{const r=await fetch('http://127.0.0.1:'+p+'/readback',{signal:AbortSignal.timeout(500)});await r.body?.cancel();n++;}catch{}if(!n)return;await new Promise(r=>setTimeout(r,200));}throw Error('OLD_LISTENERS_STILL_OPEN')})()"""
 docker('exec',OLD,'node','-e',check)
 docker('exec','-d',new,'sh','-c','exec node /fixture-clean/scripts/fixtures/resume-fresh-956-sim.mjs --resume-existing > /dev/shm/cop-clean-whole/resume-router-'+suffix+'.jsonl 2>&1')
 print(json.dumps({'contractVersion':'fresh-956-router-cutover-dispatched-v1','containerId':new,'image':image,'sameRamCredentialsCopied':True,'oldContainerPreserved':True,'productionChanged':False,'acceptancePending':True}))
if __name__=='__main__':main()
