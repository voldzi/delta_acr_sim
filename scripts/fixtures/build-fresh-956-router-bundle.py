"""Offline immutable test bundle: old main/driver/situation, newly built Router."""
import importlib.util,json,os,shutil,subprocess,sys
from pathlib import Path
OWNER='cop-clean-whole12-956262c6abdb'
BASE=Path('/srv/x5-production/staging/cop')/OWNER/'router-bundle-59fd86c'
OLD='sha256:923194d92acd6dd176c80bc8a151eb953883f80d3555b87bb45aba9da64833fa'
HERE=Path(__file__).resolve().parents[1]
def run(*args):return subprocess.check_output(args,stderr=subprocess.PIPE,timeout=900)
def docker(*args):return run('/usr/bin/docker',*args)
HASH=r'''const f=require('fs'),c=require('crypto'),p=require('path');let a=[];function scan(x,k){for(const n of f.readdirSync(x).sort()){const z=p.join(x,n),q=p.join(k,n),s=f.lstatSync(z);if(s.isDirectory())scan(z,q);else if(s.isSymbolicLink())a.push([q,"link",f.readlinkSync(z)]);else if(s.isFile())a.push([q,"file",c.createHash('sha256').update(f.readFileSync(z)).digest('hex')]);else throw Error("SPECIAL_APP_FILE");}}scan(process.argv[1],"");console.log(c.createHash('sha256').update(JSON.stringify(a)).digest('hex'));'''
def tree(image,path):return docker('run','--rm','--network','none','--label','cop.test.owner='+OWNER,'--entrypoint','node',image,'-e',HASH,path).decode().strip()
def main():
 global BASE,OLD
 assert os.getuid()==1000 and sys.argv[1:] in [['--build-only'],['--build-checked-client-v2']]
 checked=sys.argv[1:] == ['--build-checked-client-v2']
 if checked:
  BASE=BASE.parent/'router-bundle-checked-client-v2'
  OLD='sha256:739582dea16349b4d42b9c4c4b2250b6de616eaeb803b15a3013b0cc7d0a2118'
 router_tag='sim-router-checked-client-v2-20261017' if checked else 'sim-router-59fd86c-20261017'
 bundle_tag='sim-whole12-router-checked-client-v2' if checked else 'sim-whole12-router-59fd86c'
 assert run('/usr/bin/findmnt','-n','-o','UUID','--mountpoint','/srv/x5-production').decode().strip()=='2f93f595-b61b-4eea-9054-7afa9b275b5b'
 assert Path('/srv/x5-production').stat().st_dev!=Path('/').stat().st_dev
 assert shutil.disk_usage('/srv/x5-production').free>=8*1024**3
 router=json.loads(docker('image','inspect',router_tag))[0]['Id']
 assert router.startswith('sha256:') and len(router)==71
 spec=importlib.util.spec_from_file_location('extract_public',HERE/'build-whole12-tls-runtime.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
 BASE.mkdir(mode=0o700);containers=[]
 try:
  old=docker('create','--network','none','--label','cop.test.owner='+OWNER,OLD).decode().strip();containers.append(old)
  new=docker('create','--network','none','--label','cop.test.owner='+OWNER,router).decode().strip();containers.append(new)
  docker('export','--output',str(BASE/'base.tar'),old);m.extract_app(new,BASE/'router-app')
  (BASE/'Dockerfile').write_text('FROM scratch\nADD base.tar /\nCOPY router-app/ /runtime/router/\nENV NODE_ENV=production\nENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nWORKDIR /app\nUSER 1000:1000\nENTRYPOINT ["node"]\n')
  before={p:tree(OLD,p) for p in ['/app','/runtime/situation']};router_hash=tree(router,'/app')
  with (BASE/'build.log').open('wb') as log:subprocess.run(['/usr/bin/docker','buildx','build','--builder','sim-x5','--network','none','--pull=false','--load','--provenance=false','--label','cop.test.owner='+OWNER,'-t',bundle_tag,str(BASE)],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=900)
  bundle=json.loads(docker('image','inspect',bundle_tag))[0]['Id']
  assert all(tree(bundle,p)==v for p,v in before.items())
  assert tree(bundle,'/runtime/router')==router_hash
  proof={'contractVersion':'fresh-956-router-bundle-bytes-v1','routerImage':router,'testBundleImage':bundle,'unchangedTreeDigests':before,'routerTreeDigest':router_hash,'fullTreesIncludingDependencyFilesAndSymlinksEqual':True,'productionChanged':False}
  (BASE/'receipt.json').write_text(json.dumps(proof)+'\n');print(json.dumps(proof))
 finally:
  for cid in containers:docker('rm',cid)
if __name__=='__main__':main()
