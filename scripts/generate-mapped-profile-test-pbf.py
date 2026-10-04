"""Own synthetic map, not downloaded OSM. Minimal OSM-binary encoder per OSMPBF schema."""
import sys, struct, pathlib, json
def var(n):
    b=bytearray()
    while n>127: b.append((n&127)|128);n>>=7
    b.append(n);return bytes(b)
def scalar(k,n): return var(k<<3)+var(n)
def signed(k,n): return scalar(k,(n<<1)^(n>>63))
def blob(k,b): return var((k<<3)|2)+var(len(b))+b
def block(kind,data):
    b=blob(1,data);h=blob(1,kind.encode())+scalar(3,len(b));return struct.pack('!I',len(h))+h+b
strings=[''];nodes=[];ways=[];cases=[]
def sid(s):
    if s not in strings: strings.append(s)
    return strings.index(s)
def way(i,refs,tags):
    pairs=[(sid(k),sid(v)) for k,v in tags.items()];last=0;d=[]
    for r in refs: d.append((r-last)<<1 if r>=last else ((last-r)<<1)-1);last=r
    ways.append(scalar(1,i)+blob(2,b''.join(var(k) for k,v in pairs))+blob(3,b''.join(var(v) for k,v in pairs))+blob(8,b''.join(var(n) for n in d)))
for ci,(name,restriction,value) in enumerate([('height','maxheight','2.5'),('width','maxwidth','2.1'),('length','maxlength','8'),('weight','maxweight','5'),('axleLoad','maxaxleload','6'),('axleCount','maxaxles','2'),('access','motor_vehicle','no'),('unpavedFinal',None,None)]):
    x=14+ci*.01;y=50;ids=[]
    for dx,dy in [(0,0),(.001,0),(.002,0),(.003,0),(.001,.002),(.002,.002),(.004,0)]:
        ni=len(nodes)+1;ids.append(ni);nodes.append(signed(1,ni)+signed(8,round((y+dy)*1e7))+signed(9,round((x+dx)*1e7)))
    tags={'highway':'secondary','surface':'asphalt','maxspeed':'40','motor_vehicle':'yes'};wi=1000+ci*10
    way(wi,[ids[0],ids[1]],tags);way(wi+1,[ids[1],ids[2]],{**tags,**({restriction:value} if restriction else {})});way(wi+2,[ids[2],ids[3]],tags);way(wi+3,[ids[1],ids[4],ids[5],ids[2]],tags)
    way(wi+4,[ids[3],ids[6]],{'highway':'track','surface':'gravel','motor_vehicle':'yes','access':'yes','maxspeed':'20'})
    cases.append({'name':name,'from':{'lon':x+.0002,'lat':y},'to':{'lon':x+(.0038 if name=='unpavedFinal' else .0028),'lat':y},'restrictedWay':wi+1,'finalWay':wi+4})
table=b''.join(blob(1,s.encode()) for s in strings)
primitives=blob(1,table)+blob(2,b''.join(blob(1,n) for n in nodes))+blob(2,b''.join(blob(3,w) for w in ways))
header=blob(4,b'OsmSchema-V0.6')+blob(16,b'CSM SIM synthetic profile test')+blob(17,b'GENERATED SYNTHETIC, not real OSM data')+scalar(32,1791090671)
out=pathlib.Path(sys.argv[1]);out.mkdir(mode=0o700,parents=True,exist_ok=True)
(out/'synthetic.osm.pbf').write_bytes(block('OSMHeader',header)+block('OSMData',primitives))
(out/'cases.json').write_text(json.dumps(cases))
print(json.dumps({'synthetic':True,'nodes':len(nodes),'ways':len(ways),'cases':len(cases)}))
