"""Only the exact failed public build artifacts, never a prune or user data."""
import hashlib,json,os,shutil,subprocess
from pathlib import Path
BASE=Path('/srv/x5-production/staging/cop/cop-clean-whole12-9aff26e65b74/sim-runtime-build')
assert os.getuid()==1000 and BASE.resolve()==BASE and BASE.is_dir() and BASE.stat().st_uid==1000
assert set(p.name for p in BASE.iterdir())<= {'main-rootfs.tar','router-app','router-probe'}
assert not (BASE/'receipt.json').exists()
containers=json.loads(subprocess.check_output(['/usr/bin/docker','ps','-aq']).decode() and subprocess.check_output(['/usr/bin/docker','inspect',*subprocess.check_output(['/usr/bin/docker','ps','-aq']).decode().split()]) or b'[]')
assert not any(str(m.get('Source','')).startswith(str(BASE)) for c in containers for m in c.get('Mounts',[]))
for proc in Path('/proc').iterdir():
    if not proc.name.isdigit() or int(proc.name)==os.getpid():continue
    try:
        argv=(proc/'cmdline').read_bytes().split(b'\0')
        assert not any(x==str(BASE).encode() for x in argv),'BUILD_STILL_RUNNING'
        for fd in (proc/'fd').iterdir():
            try:assert not os.readlink(fd).startswith(str(BASE)),'BUILD_FILE_OPEN'
            except FileNotFoundError:pass
    except (PermissionError,FileNotFoundError,ProcessLookupError):pass
inventory=[]
for folder,dirs,files in os.walk(BASE,followlinks=False):
    for name in dirs+files:
        p=Path(folder)/name;s=p.lstat();assert s.st_uid==1000
        if p.is_symlink():
            assert p.resolve(strict=False).is_relative_to(BASE)
            inventory.append({'path':str(p.relative_to(BASE)),'symlink':os.readlink(p)})
        elif p.is_file():
            h=hashlib.sha256()
            with p.open('rb')as f:
                for b in iter(lambda:f.read(1048576),b''):h.update(b)
            inventory.append({'path':str(p.relative_to(BASE)),'bytes':s.st_size,'sha256':h.hexdigest()})
        else:assert p.is_dir()
receipt={'contract':'whole12-own-failed-public-build-cleanup-v1','path':str(BASE),'fileCount':len(inventory),'bytes':sum(x.get('bytes',0) for x in inventory),'inventorySha256':hashlib.sha256(json.dumps(inventory,sort_keys=True).encode()).hexdigest(),'productionTouched':False}
with (BASE.parent/'sim-runtime-build-failure-inventory.json').open('x')as f:json.dump(receipt,f,indent=2)
shutil.rmtree(BASE)
print(json.dumps(receipt))
