"""Finite local SIM base conversion; no Docker, shell, network or app operations.
Root caller supplies its private owned save file and a not-yet-existing layout.
All archive headers are checked before tar extensions can be interpreted.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tarfile
import time

BASE='sha256:4076069b3f8c935c0cd07ea2bf95d92703270b72197ff2b74a27d1aee8c6bdf0'
BASE_SIZE=203231596
MAX_SAVE=2*BASE_SIZE+16777216
MAX_UNPACKED=2*BASE_SIZE+16777216
class Rejected(Exception):pass
def need(value,code='SIM_OCI_BASE_REJECTED'):
 if not value:raise Rejected(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def encoded(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def stable(s):return (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_uid,s.st_gid,s.st_mode,s.st_nlink)
def private_parent(path):
 need(path.is_absolute() and not any(p.is_symlink() for p in [path,*path.parents]))
 s=path.stat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o700)
def write_new(path,raw):
 fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as out:out.write(raw);out.flush();os.fsync(out.fileno())
def convert_stream(reader,output,base):
 """Bounded image-save stream to ONE OCI copy; no complete save.tar is staged.
 The Root driver must use its fixed deadline pipe reader (not an unbounded IO).
 """
 output=Path(output);private_parent(output.parent);need(not output.exists() and not output.is_symlink())
 need(base.get('Id')==BASE and base.get('Size')==BASE_SIZE and base.get('Os')=='linux' and base.get('Architecture')=='amd64' and not (base.get('Config') or {}).get('OnBuild'))
 ids=base.get('RootFS',{}).get('Layers');need(isinstance(ids,list) and len(ids)==14 and all(isinstance(v,str) and re.fullmatch('sha256:[0-9a-f]{64}',v) for v in ids))
 deadline=time.monotonic()+120;consumed=0;unpacked=0;members={};config=None;manifest=None
 def read(n,empty=False):
  nonlocal consumed
  need(time.monotonic()<deadline,'SIM_OCI_CONVERSION_DEADLINE');raw=reader.read(n)
  need(isinstance(raw,bytes) and len(raw)<=n and (raw or empty));consumed+=len(raw);need(consumed<=MAX_SAVE and time.monotonic()<deadline,'SIM_OCI_STREAM_BUDGET_OR_DEADLINE');return raw
 def exact(n):
  chunks=[]
  while n:
   raw=read(min(n,65536));chunks.append(raw);n-=len(raw)
  return b''.join(chunks)
 output.mkdir(mode=0o700);(output/'blobs').mkdir(mode=0o700);blobs=output/'blobs/sha256';blobs.mkdir(mode=0o700)
 while True:
  header=exact(512)
  if header==b'\0'*512:
   need(exact(512)==b'\0'*512)
   while True:
    tail=read(65536,True)
    if not tail:break
    need(not tail.strip(b'\0'))
   break
  member=tarfile.TarInfo.frombuf(header,'utf-8','strict');name=member.name.rstrip('/')
  need(member.type in {tarfile.REGTYPE,tarfile.AREGTYPE,tarfile.DIRTYPE} and member.size>=0 and not member.linkname)
  need(name and not name.startswith('/') and '\\' not in name and all(p not in {'','.','..'} for p in name.split('/')) and name not in members and len(members)<4096)
  if member.isdir():need(member.size==0);members[name]=None;continue
  need(member.size<=MAX_SAVE-consumed)
  temporary=blobs/('member-'+str(len(members))+'.partial');fd=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
  h=hashlib.sha256();remaining=member.size;small=[] if remaining<=4194304 else None
  with os.fdopen(fd,'wb') as out:
   while remaining:
    raw=exact(min(remaining,65536));remaining-=len(raw);h.update(raw);out.write(raw)
    if small is not None:small.append(raw)
   out.flush();os.fsync(out.fileno())
  need(exact((-member.size)%512)==b'\0'*((-member.size)%512))
  digest='sha256:'+h.hexdigest();layer_id=None;compressed=False
  if digest in ids:layer_id=digest;unpacked+=member.size
  else:
   with temporary.open('rb') as saved:
    compressed=saved.read(2)==b'\x1f\x8b';saved.seek(0)
    if compressed:
     u=hashlib.sha256()
     with gzip.GzipFile(fileobj=saved) as decoded:
      while True:
       need(time.monotonic()<deadline,'SIM_OCI_CONVERSION_DEADLINE');raw=decoded.read(65536)
       if not raw:break
       unpacked+=len(raw);need(unpacked<=MAX_UNPACKED);u.update(raw)
     layer_id='sha256:'+u.hexdigest();need(layer_id in ids)
  need(unpacked<=MAX_UNPACKED)
  payload=b''.join(small) if small is not None else None
  if digest==BASE:need(payload is not None);config=payload
  if name=='manifest.json':need(payload is not None and len(payload)<=1048576);manifest=json.loads(payload)
  members[name]={'digest':digest,'diffId':layer_id,'size':member.size,'compressed':compressed}
  if layer_id is not None or digest==BASE:
   destination=blobs/digest[7:]
   if destination.exists():
    # Same digest/size is already bound by this owned conversion; no replacement.
    need(destination.stat().st_size==member.size);temporary.unlink()
   else:os.rename(temporary,destination)
  else:temporary.unlink()
 need(config is not None and isinstance(manifest,list) and len(manifest)==1 and isinstance(manifest[0],dict))
 c=json.loads(config);need(c.get('architecture')=='amd64' and c.get('os')=='linux' and c.get('rootfs',{}).get('diff_ids')==ids and c.get('config')==base.get('Config'))
 item=manifest[0];config_member=members.get(item.get('Config'));layers=item.get('Layers')
 need(config_member and config_member['digest']==BASE and isinstance(layers,list) and len(layers)==14 and len(set(layers))==14)
 descriptors=[]
 for index,name in enumerate(layers):
  member=members.get(name);need(member and member['diffId']==ids[index])
  descriptors.append({'mediaType':'application/vnd.oci.image.layer.v1.tar+gzip' if member['compressed'] else 'application/vnd.oci.image.layer.v1.tar','digest':member['digest'],'size':member['size']})
 oci={'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'mediaType':'application/vnd.oci.image.config.v1+json','digest':BASE,'size':len(config)},'layers':descriptors}
 raw=encoded(oci);digest='sha256:'+sha(raw);write_new(blobs/sha(raw),raw)
 write_new(output/'oci-layout',encoded({'imageLayoutVersion':'1.0.0'}))
 write_new(output/'index.json',encoded({'schemaVersion':2,'manifests':[{'mediaType':oci['mediaType'],'digest':digest,'size':len(raw),'platform':{'architecture':'amd64','os':'linux'}}]}))
 directory=os.open(output,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(directory)
 finally:os.close(directory)
 return {'contract':'sim-pg-base-oci-stream-v1','configDigest':BASE,'ociManifestDigest':digest,'layersVerified':14,'inputBytes':consumed,'uncompressedBytesVerified':unpacked,'saveArchiveStaged':False,'buildPerformed':False}
def convert(archive_path,output,base):
 """Owned-file fixture/inspection adapter; production uses convert_stream directly."""
 archive_path=Path(archive_path);private_parent(archive_path.parent)
 fd=os.open(archive_path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb') as stream:
  before=os.fstat(stream.fileno());need(stat.S_ISREG(before.st_mode) and before.st_uid==os.geteuid() and before.st_nlink==1 and stat.S_IMODE(before.st_mode)==0o600 and 1024<=before.st_size<=MAX_SAVE)
  result=convert_stream(stream,output,base)
  need(stable(os.fstat(stream.fileno()))==stable(before) and os.lstat(archive_path).st_ino==before.st_ino)
  return result
