#!/usr/bin/env python3
"""Prepare an INERT local review bundle. No Docker, network, GO or host writes.

Only a clean committed checkout is packaged. Runtime bytes and reviewed host
sources are pinned separately; a bundle/manifest is never deployment authority.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

REPO=Path(__file__).resolve().parents[1]
BASE='sha256:4076069b3f8c935c0cd07ea2bf95d92703270b72197ff2b74a27d1aee8c6bdf0'
REVIEWED='c00929ec2b5ab3e7250d260ee997d8b411a61827'
# The build subtree has exactly Dockerfile + three COPY inputs. No full repo,
# .env, auth files, dependency installation or alternate app features enter it.
PINNED={
 'build/Dockerfile':('deploy/sim-pg-disconnect.Dockerfile','1239b1fd4844c738d1856fbad1e790ff90862a03c34496e2bf36a569740a45c5'),
 'build/apps/simulator-api/dist/user-data.js':('apps/simulator-api/dist/user-data.js','e78d951eb538f4962542c28c8436db45713ff3ba7588d8d2c98a0f4f34ab72bd'),
 'build/packages/sim-user-data/bootstrap.mjs':('packages/sim-user-data/bootstrap.mjs','c1b44b61e7ac7902463f1d68c6fec74dccf3550b4a3d95d02544788436d11d05'),
 'build/packages/sim-user-data/pg-errors.mjs':('packages/sim-user-data/pg-errors.mjs','af3c90eec2a0702e434feb57cd7607a8d7fb7c84c8f1d10c8084b7d13b16b2fc'),
 'source/sim-pg-disconnect-maintain.py':('scripts/sim-pg-disconnect-maintain.py','ca8eea78577ccc5da12d25c2c06342f3de2c762dacc699272a01b10bc2a1dac7'),
 'source/sim-maintenance-lineage-probe.mjs':('scripts/sim-maintenance-lineage-probe.mjs','b3f8424c842d140335545382f81bb185a4f22295ba0ce61552ddf07c27b49aa7'),
 'source/sim-pg-disconnect-baseline.py':('scripts/sim-pg-disconnect-baseline.py','b9b1b6fd66d37f5bcc1cc64f0cafa1b09ca90e8764385b4f96b32d0b8e9e364a'),
}
RECEIPTS={
 'handler21':'af4c7464dc50cf9528ed0350bd33290a6f13e0002ce678da1768019de4c5013d',
 'pg29':'cc10cd08f11ba85bf4bf8ed3ce51b3833c965115030bef883ab8f3ec581cdc4a',
 'probe12':'50a42287c4d7caf87a361de03f67d8595e11d344f0c61fad8ad6ee5d34d61ae9',
}
for name,digest in RECEIPTS.items():
 path='docs/testing/receipts/sim-maintenance-20261028-'+name+'.json'
 PINNED['evidence/'+Path(path).name]=(path,digest)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def need(value):
 if not value:raise RuntimeError('SIM_BUNDLE_REJECTED')
def git(*args):return subprocess.check_output(['git',*args],cwd=REPO,stderr=subprocess.DEVNULL,text=True).strip()
def collect():
 entries={}
 for target,(relative,expected) in PINNED.items():
  p=REPO/relative;need(p.is_file() and not any(x.is_symlink() for x in [p,*p.parents]) and p.stat().st_size<1048576)
  raw=p.read_bytes();need(sha(raw)==expected);entries[target]=raw
 return entries
def archive(entries,revision):
 manifest={'contract':'sim-pg-maintenance-inert-bundle-v1','sourceRevision':revision,'priorReviewedRevision':REVIEWED,'requiresFreshSourceReview':True,
  'baseImage':BASE,'candidateImage':None,'deploymentAuthority':False,'containsSecrets':False,
  'capacityPlan':{'requiresFreshRootReview':True,'baseImageSizeBytes':None,
   'runtimeInputBytes':sum(len(raw) for p,raw in entries.items() if p.startswith('build/') and p!='build/Dockerfile'),
   'maximumThreeCopyLayerBytes':3*2097152,'minimumResidualReserveBytes':2147483648,
   'builderScratchAndMetadataBudgetBytes':1073741824,
   'rootRequiredFreeFormula':'2*actualBaseImageSize + 1073741824 + 6291456 + actualBundleBytes + max(2147483648, RootExistingReserve)',
   'x5RequiredFreeFormula':'actualBundleBytes + max(2147483648, RootExistingReserve)',
   'exportDiskStagingBytes':0,'retainedBaseImage':True,'registryPullOrFullRebuildAllowed':False},
  'files':{p:{'sha256':sha(raw),'size':len(raw),'mode':'0644'} for p,raw in sorted(entries.items())},
  'gatesRequired':['fresh Root capacity/build-owner/build GO','actual image digest/config/base+3COPY/export verification',
   'protected Root profile and fresh current facts/GO','single forward acceptance','separate fresh current-lineage reverse GO']}
 payload={**entries,'manifest.json':(json.dumps(manifest,sort_keys=True,indent=2)+'\n').encode()}
 out=io.BytesIO()
 with tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as tar:
  for name,raw in sorted(payload.items()):
   t=tarfile.TarInfo(name);t.mode=0o644;t.uid=t.gid=t.mtime=0;t.size=len(raw);tar.addfile(t,io.BytesIO(raw))
 return out.getvalue()
def main():
 need(not git('status','--porcelain','--untracked-files=all'))
 revision=git('rev-parse','HEAD');need(git('merge-base','--is-ancestor',REVIEWED,revision)=='')
 entries=collect();raw=archive(entries,revision)
 need(git('rev-parse','HEAD')==revision and not git('status','--porcelain','--untracked-files=all') and collect()==entries)
 directory=Path(tempfile.mkdtemp(prefix='sim-pg-maintenance-',dir='/private/tmp'));os.chmod(directory,0o700)
 target=directory/'review-bundle.tar'
 fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as out:out.write(raw);out.flush();os.fsync(out.fileno())
 need(target.read_bytes()==raw)
 print(json.dumps({'bundle':str(target),'sha256':sha(raw),'bundleBytes':len(raw),'sourceRevision':revision,'files':len(entries)+1,'candidateImage':None,'deploymentAuthority':False}))
if __name__=='__main__':main()
