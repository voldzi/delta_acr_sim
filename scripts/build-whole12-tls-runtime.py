"""Offline TEST image from three fixed images, no install/deploy/shared builder."""
import hashlib, importlib.util, json, os, shutil, subprocess, tarfile, posixpath
from pathlib import Path
OWNER='cop-clean-whole12-9aff26e65b74'
BASE=Path('/srv/x5-production/staging/cop')/OWNER/'sim-runtime-build-v2'
IMAGES={'main':'sha256:3715142fd72e3991a22b6208b387da425182b95753737867e42d6fb502a5ce4a',
        'router':'sha256:971638e9517f29dd94a4f19dad062831ba35f9ea2018807b4041906f1d47c1b5',
        'situation':'sha256:adcc0e06476531d7270e406606bd10e46bf4c1cae350835db4099b68263a6025'}
TAG='sim-whole12-tls-a337-20261017'
HERE=Path(__file__).resolve().parent
def run(*args,timeout=180):
    return subprocess.check_output(args,stderr=subprocess.PIPE,timeout=timeout)
def docker(*args,**kw):return run('/usr/bin/docker',*args,**kw)
def extract_app(cid,destination):
    destination.mkdir(mode=0o700)
    process=subprocess.Popen(['/usr/bin/docker','export',cid],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    links=[]
    try:
        with tarfile.open(fileobj=process.stdout,mode='r|') as archive:
            for member in archive:
                if not member.name.startswith('app/'):continue
                name=member.name[4:]
                assert name and not name.startswith('/') and '..' not in Path(name).parts
                target=destination/name
                assert target.parent.resolve().is_relative_to(destination)
                if member.isdir():target.mkdir(mode=0o700,parents=True,exist_ok=True)
                elif member.isfile():
                    target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
                    assert not target.exists() and not target.is_symlink()
                    with archive.extractfile(member) as source,target.open('xb') as out:shutil.copyfileobj(source,out)
                    target.chmod((member.mode&0o755)|0o600)
                elif member.issym():
                    normalized=posixpath.normpath(posixpath.join(posixpath.dirname(name),member.linkname))
                    assert not member.linkname.startswith('/') and normalized!='..' and not normalized.startswith('../')
                    target.symlink_to(member.linkname)
                elif member.islnk():links.append((target,member.linkname))
                else:raise RuntimeError('UNKNOWN_PUBLIC_APP_ARCHIVE_ENTRY')
        assert process.wait(timeout=30)==0
        for target,link in links:
            assert link.startswith('app/') and '..' not in Path(link).parts
            source=destination/link[4:]
            assert source.is_file() and source.resolve().is_relative_to(destination)
            shutil.copyfile(source,target)
        for folder,dirs,_ in os.walk(destination,followlinks=False):
            Path(folder).chmod(0o755)
    finally:
        if process.poll() is None:process.kill();process.wait()
HASH_JS=r'''const f=require('fs'),c=require('crypto'),p=require('path');let out={};function scan(root,k){if(!f.existsSync(root))return;for(const n of f.readdirSync(root).sort()){let a=p.join(root,n),b=p.join(k,n),s=f.lstatSync(a);if(s.isDirectory())scan(a,b);else if(s.isFile())out[b]=c.createHash('sha256').update(f.readFileSync(a)).digest('hex');}}for(const n of ['apps','packages','deploy','openapi','docs/api/schemas'])scan(process.argv[1]+'/'+n,n);console.log(JSON.stringify(out));'''
def main():
    assert os.getuid()==1000
    spec=importlib.util.spec_from_file_location('owned_build',HERE/'prepare-sim-clean-build.py')
    check=importlib.util.module_from_spec(spec);spec.loader.exec_module(check)
    check.layout();check.builder_check();before=check.running()
    assert shutil.disk_usage('/srv/x5-production').free>=3*1024**3
    assert BASE.parent.resolve()==BASE.parent and BASE.parent.stat().st_uid==1000
    BASE.mkdir(mode=0o700)
    containers=[];receipts={}
    try:
        for lane,image in IMAGES.items():
            assert json.loads(docker('image','inspect',image))[0]['Id']==image
            name=OWNER+'-extract-'+lane
            cid=docker('create','--network','none','--label','cop.test.owner='+OWNER,'--name',name,image).decode().strip();containers.append(cid)
            if lane=='main':docker('export','--output',str(BASE/'main-rootfs.tar'),cid)
            else:extract_app(cid,BASE/(lane+'-app'))
            receipts[lane]=json.loads(docker('run','--rm','--network','none','--label','cop.test.owner='+OWNER,'--entrypoint','node',image,'-e',HASH_JS,'/app'))
        shutil.copyfile(HERE/'fixtures/whole12-tls-runtime.Dockerfile',BASE/'Dockerfile')
        with (BASE/'build.log').open('wb') as log:
            subprocess.run(['/usr/bin/docker','buildx','build','--builder','sim-x5','--network','none','--pull=false','--load','--provenance=false','--label','cop.test.owner='+OWNER,'-t',TAG,str(BASE)],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=900)
        image=json.loads(docker('image','inspect',TAG))[0]['Id']
        for lane,path in [('main','/app'),('router','/runtime/router'),('situation','/runtime/situation')]:
            actual=json.loads(docker('run','--rm','--network','none','--label','cop.test.owner='+OWNER,'--entrypoint','node',image,'-e',HASH_JS,path))
            assert actual==receipts[lane],lane+' original candidate bytes changed'
        assert check.running()==before
        result={'contractVersion':'sim-whole12-test-runtime-v1','testBundleImage':image,'originalImages':IMAGES,'treeHashes':{k:hashlib.sha256(json.dumps(v,sort_keys=True).encode()).hexdigest() for k,v in receipts.items()},'actualOriginalBytesEqual':True,'productionServicesChanged':False,'owner':OWNER}
        (BASE/'receipt.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result))
    finally:
        for cid in containers:docker('rm',cid)
if __name__=='__main__':main()
