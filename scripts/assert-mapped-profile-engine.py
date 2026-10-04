import json,sys,urllib.request
plan=json.load(sys.stdin)
def request(path,payload):
 req=urllib.request.Request('http://127.0.0.1:8002/'+path,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=15) as r:return json.load(r)
status=request('status',{})
assert status['version']=='3.8.3'
results=[]
for c in plan:
 r=request('route',c['request'])
 assert not r.get('warnings'),(c['name'],r.get('warnings'))
 assert r['trip']['status']==0 and len(r['trip']['legs'])==1,c['name']
 leg=r['trip']['legs'][0]
 traced=request('trace_attributes',{'encoded_polyline':leg['shape'],'shape_match':'edge_walk','costing':c['request']['costing'],'costing_options':c['request']['costing_options'],'filters':{'action':'include','attributes':['edge.way_id','edge.id','edge.length']}})
 ways=[e['way_id'] for e in traced['edges']]
 assert (c['restrictedWay'] in ways)==c['expectedRestricted'],(c['name'],ways,c['expectedRestricted'])
 if c['finalWay']:assert c['finalWay'] in ways,(c['name'],ways)
 assert leg['maneuvers'] and all('begin_shape_index' in m and 'end_shape_index' in m for m in leg['maneuvers'])
 results.append({'test':c['name'],'costing':c['request']['costing'],'restrictedWayUsed':c['restrictedWay'] in ways,'finalTrackUsed':bool(c['finalWay'] and c['finalWay'] in ways),'distanceKm':r['trip']['summary']['length'],'indexedManeuvers':len(leg['maneuvers'])})
print(json.dumps({'syntheticOnly':True,'engineVersion':status['version'],'passed':len(results),'results':results}))
