import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import type { SituationDataConfig } from "./config.js";
import { problem } from "./http.js";
import { PostgresDriverMeasurementStore } from "./driver-measurement-store.js";

export const DRIVER_CONTRACT = "sim-driver-measurements-v1";
const PREFIX = "/api/v1/internal/driver-measurements/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE = /^[A-Za-z0-9_-]{32,128}$/;
const DATASET = /^sim-routing-\d{4}-\d{2}-\d{2}-\d+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export class DriverMeasurementError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const invalid = (): never => { throw new DriverMeasurementError(400, "DRIVER_MEASUREMENT_INVALID"); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) return invalid();
  return value as Record<string, unknown>;
}
function number(value: unknown, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) return invalid();
  return value;
}
function stamp(value: unknown): string {
  if (typeof value !== "string" || !ISO.test(value) || !Number.isFinite(Date.parse(value))) return invalid();
  const normalized=new Date(value).toISOString();
  if (normalized.slice(0,19)!==value.slice(0,19)) return invalid();
  return normalized;
}
function uuid(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) return invalid(); return value.toLowerCase(); }
function opaque(value: unknown): string { if (typeof value !== "string" || !OPAQUE.test(value)) return invalid(); return value; }

export interface DriverPoint {
  sampleId: string; observedAt: string; lat: number; lon: number;
  horizontalAccuracyM: number; speedMps: number; speedAccuracyMps: number;
  headingDeg: number; headingAccuracyDeg: number;
  positionSource: "gps" | "estimated" | "simulated";
  motion: "driving" | "traffic_stop" | "personal_stop" | "paused" | "unknown";
  reducedAccuracy: boolean;
}
export interface DriverBatch {
  contractVersion: typeof DRIVER_CONTRACT; batchId: string; contributorIdDay: string;
  contributorDay: string; consent: { version: "traffic-quality-v1"; grantedAt: string; attestation: "cop-driver-consent-v1" };
  vehicleClass: "passenger_car"; points: DriverPoint[];
  eta?: { observationId: string; routingDataset: string; predictedDurationSeconds: number; actualDurationSeconds: number;
    plannedDistanceM: number; actualDistanceM: number; personalStopSeconds: number; estimatedSeconds: number;
    offRoute: boolean; completedAt: string };
}
export interface DriverInterval {
  key: string; dataset: string; edgeId: string; windowStart: string;
  speedKph: number; distanceM: number; elapsedSeconds: number;
}
export interface DriverReceipt {
  contractVersion: typeof DRIVER_CONTRACT; batchId: string; receivedAt: string;
  acceptedIntervalCount: number; deduplicatedIntervalCount: number;
  rejectionCounts: Record<string, number>; etaAccepted: boolean;
  applicationMode: "shadow_only"; rawPositionsStored: false;
}
export interface DriverStore {
  lookup(owner: string, batchId: string, hash: string): Promise<DriverReceipt | undefined>;
  commit(owner: string, contributor: string, hash: string, batch: DriverBatch, intervals: DriverInterval[], receipt: DriverReceipt): Promise<DriverReceipt>;
  aggregates(dataset: string, since: string, now: string): Promise<unknown[]>;
  quality(now: string): Promise<unknown>;
  revoke(owner: string, contributor: string): Promise<number>;
  close(): Promise<void>;
}
export interface DriverMatch {
  dataset: string;
  points: Array<{ edgeId?: string; fraction?: number; distanceM?: number; matched: boolean; disconnected: boolean; edgeLengthM?: number }>;
}
export interface DriverMatcher { match(points: DriverPoint[]): Promise<DriverMatch>; dataset(): Promise<string> }

export function parseDriverBatch(value: unknown, now: number): DriverBatch {
  const raw = object(value, ["contractVersion", "batchId", "contributorIdDay", "contributorDay", "consent", "vehicleClass", "points", "eta"]);
  if (raw.contractVersion !== DRIVER_CONTRACT || raw.vehicleClass !== "passenger_car") return invalid();
  const consent = object(raw.consent, ["version", "grantedAt", "attestation"]);
  if (consent.version !== "traffic-quality-v1" || consent.attestation !== "cop-driver-consent-v1")
    throw new DriverMeasurementError(403, "DRIVER_CONSENT_REQUIRED");
  const grantedAt = stamp(consent.grantedAt);
  if (Date.parse(grantedAt) > now + 30000) return invalid();
  if (!Array.isArray(raw.points) || raw.points.length < 3 || raw.points.length > 120) return invalid();
  const ids = new Set<string>(); let previous = -Infinity;
  const points = raw.points.map(item => {
    const p = object(item, ["sampleId", "observedAt", "lat", "lon", "horizontalAccuracyM", "speedMps", "speedAccuracyMps", "headingDeg", "headingAccuracyDeg", "positionSource", "motion", "reducedAccuracy"]);
    const sampleId = uuid(p.sampleId), observedAt = stamp(p.observedAt), time = Date.parse(observedAt);
    if (ids.has(sampleId) || time <= previous || time > now + 30000 || time < now - 86400000 || time < Date.parse(grantedAt)) return invalid();
    ids.add(sampleId); previous = time;
    if (!["gps", "estimated", "simulated"].includes(String(p.positionSource)) ||
        !["driving", "traffic_stop", "personal_stop", "paused", "unknown"].includes(String(p.motion)) || typeof p.reducedAccuracy !== "boolean") return invalid();
    return { sampleId, observedAt, lat: number(p.lat, -90, 90), lon: number(p.lon, -180, 180),
      horizontalAccuracyM: number(p.horizontalAccuracyM, 0, 10000), speedMps: number(p.speedMps, 0, 70),
      speedAccuracyMps: number(p.speedAccuracyMps, 0, 100), headingDeg: number(p.headingDeg, 0, 359.999999),
      headingAccuracyDeg: number(p.headingAccuracyDeg, 0, 180), positionSource: p.positionSource as DriverPoint["positionSource"],
      motion: p.motion as DriverPoint["motion"], reducedAccuracy: p.reducedAccuracy };
  });
  if (Date.parse(points.at(-1)!.observedAt) - Date.parse(points[0]!.observedAt) > 600000) return invalid();
  const contributorDay = raw.contributorDay;
  if (typeof contributorDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(contributorDay) || points.some(p => p.observedAt.slice(0,10) !== contributorDay)) return invalid();
  let eta: DriverBatch["eta"];
  if (raw.eta !== undefined) {
    const e = object(raw.eta, ["observationId", "routingDataset", "predictedDurationSeconds", "actualDurationSeconds", "plannedDistanceM", "actualDistanceM", "personalStopSeconds", "estimatedSeconds", "offRoute", "completedAt"]);
    if (typeof e.routingDataset !== "string" || !DATASET.test(e.routingDataset) || typeof e.offRoute !== "boolean") return invalid();
    eta = { observationId: uuid(e.observationId), routingDataset: e.routingDataset, predictedDurationSeconds: number(e.predictedDurationSeconds, 1, 86400),
      actualDurationSeconds: number(e.actualDurationSeconds, 1, 86400), plannedDistanceM: number(e.plannedDistanceM, 100, 2000000),
      actualDistanceM: number(e.actualDistanceM, 100, 2000000), personalStopSeconds: number(e.personalStopSeconds, 0, 86400),
      estimatedSeconds: number(e.estimatedSeconds, 0, 86400), offRoute: e.offRoute, completedAt: stamp(e.completedAt) };
    if (eta.personalStopSeconds + eta.estimatedSeconds > eta.actualDurationSeconds || Date.parse(eta.completedAt) > now + 30000 || Date.parse(eta.completedAt) < now - 86400000 || Date.parse(eta.completedAt) < Date.parse(grantedAt)) return invalid();
  }
  return { contractVersion: DRIVER_CONTRACT, batchId: uuid(raw.batchId), contributorIdDay: opaque(raw.contributorIdDay), contributorDay,
    consent: { version: "traffic-quality-v1", grantedAt, attestation: "cop-driver-consent-v1" }, vehicleClass: "passenger_car", points, ...(eta ? { eta } : {}) };
}

function distance(a: DriverPoint, b: DriverPoint): number {
  const rad = Math.PI / 180, dlat = (b.lat-a.lat)*rad, dlon = (b.lon-a.lon)*rad;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(Math.sin(dlat/2)**2 + Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlon/2)**2)));
}
function bearing(a: DriverPoint, b: DriverPoint): number {
  const rad=Math.PI/180, delta=(b.lon-a.lon)*rad, x=Math.cos(a.lat*rad)*Math.sin(b.lat*rad)-Math.sin(a.lat*rad)*Math.cos(b.lat*rad)*Math.cos(delta);
  return (Math.atan2(Math.sin(delta)*Math.cos(b.lat*rad),x)/rad+360)%360;
}
export function deriveDriverIntervals(batch: DriverBatch, match: DriverMatch): { intervals: DriverInterval[]; rejectionCounts: Record<string, number>; etaAccepted: boolean } {
  if (!DATASET.test(match.dataset) || match.points.length !== batch.points.length) throw new DriverMeasurementError(503, "DRIVER_MATCH_UNAVAILABLE");
  const intervals: DriverInterval[] = [], rejectionCounts: Record<string,number> = {};
  const reject = (reason: string) => { rejectionCounts[reason] = (rejectionCounts[reason] ?? 0)+1; };
  for (let i=1; i<batch.points.length; i++) {
    const a=batch.points[i-1]!, b=batch.points[i]!, x=match.points[i-1]!, y=match.points[i]!;
    const seconds=(Date.parse(b.observedAt)-Date.parse(a.observedAt))/1000;
    if ([a,b].some(p => p.positionSource !== "gps" || p.reducedAccuracy)) { reject("non_measured_position"); continue; }
    if ([a,b].some(p => p.horizontalAccuracyM > 15 || p.speedAccuracyMps > 2 || p.headingAccuracyDeg > 20)) { reject("low_sensor_quality"); continue; }
    if ([a,b].some(p => !["driving", "traffic_stop"].includes(p.motion))) { reject("personal_stop_or_unknown_motion"); continue; }
    if (seconds < 1 || seconds > 10) { reject("sampling_gap"); continue; }
    if (!x.matched || !y.matched || x.disconnected || y.disconnected || !x.edgeId || x.edgeId !== y.edgeId ||
        !/^\d+$/.test(x.edgeId) || !Number.isSafeInteger(Number(x.edgeId)) || Number(x.edgeId) < 0 || Number(x.edgeId) >= 2**46 || (Number(x.edgeId)%8)>2 ||
        !Number.isFinite(x.distanceM) || !Number.isFinite(y.distanceM) || x.distanceM! < 0 || y.distanceM! < 0 || x.distanceM! > 10 || y.distanceM! > 10 ||
        !Number.isFinite(x.fraction) || !Number.isFinite(y.fraction) || x.fraction! < 0 || y.fraction! > 1 || y.fraction! <= x.fraction! ||
        !Number.isFinite(x.edgeLengthM) || x.edgeLengthM! <= 0) { reject("ambiguous_or_noncontinuous_edge"); continue; }
    const meters=(y.fraction!-x.fraction!)*x.edgeLengthM!, measured=meters/seconds, gps=distance(a,b)/seconds;
    const course=bearing(a,b);
    if ([a,b].some(p=>p.speedMps>=2 && Math.abs(((p.headingDeg-course+540)%360)-180)>35)) { reject("heading_inconsistent"); continue; }
    if (meters < 10 || measured > 70 || Math.abs(measured-gps) > Math.max(4, measured*.3) ||
        [a,b].some(p => Math.abs(p.speedMps-measured) > Math.max(4, measured*.3))) { reject("speed_or_distance_inconsistent"); continue; }
    const key=createHash("sha256").update(`${batch.contributorIdDay}:${a.sampleId}:${b.sampleId}`).digest("hex");
    intervals.push({ key, dataset: match.dataset, edgeId: x.edgeId, windowStart: new Date(Math.floor(Date.parse(b.observedAt)/300000)*300000).toISOString(),
      speedKph: measured*3.6, distanceM: meters, elapsedSeconds: seconds });
  }
  const e=batch.eta;
  const etaAccepted=!!e && intervals.length>0 && e.routingDataset===match.dataset && !e.offRoute && e.estimatedSeconds===0 && e.personalStopSeconds===0 &&
    Math.abs(e.actualDistanceM-e.plannedDistanceM)/e.plannedDistanceM <= .05;
  if (e && !etaAccepted) reject("eta_not_comparable");
  return { intervals, rejectionCounts, etaAccepted };
}

export class ValhallaDriverMatcher implements DriverMatcher {
  constructor(private base: string) {}
  private async request(path: string, signal: AbortSignal, body?: unknown): Promise<Record<string, any>> {
    const r=await fetch(`${this.base.replace(/\/$/, "")}${path}`, { method: body ? "POST" : "GET", redirect: "error", signal,
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    if (!r.ok || !r.body) throw new DriverMeasurementError(503,"DRIVER_MATCH_UNAVAILABLE");
    const chunks: Uint8Array[]=[]; let size=0;
    for await (const chunk of r.body) { size+=chunk.length; if (size>2097152) throw new DriverMeasurementError(503,"DRIVER_MATCH_UNAVAILABLE"); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private version(status: Record<string,any>): string {
    const time=status.tileset_last_modified;
    if (!Number.isSafeInteger(time) || time<=0) throw new DriverMeasurementError(503,"DRIVER_MATCH_UNAVAILABLE");
    return `sim-routing-${new Date(time*1000).toISOString().slice(0,10)}-${time}`;
  }
  async dataset(): Promise<string> { return this.version(await this.request("/status",AbortSignal.timeout(8000))); }
  async match(points: DriverPoint[]): Promise<DriverMatch> {
    const signal=AbortSignal.timeout(8000), before=this.version(await this.request("/status",signal));
    const result=await this.request("/trace_attributes",signal, { costing:"auto", shape_match:"map_snap", units:"kilometers",
      shape:points.map(p=>({lat:p.lat,lon:p.lon,time:Math.floor(Date.parse(p.observedAt)/1000)})),
      trace_options:{gps_accuracy:10,search_radius:30,breakage_distance:500},
      // edge.length includes partial-edge source/target fractions in Valhalla.
      filters:{action:"include",attributes:["edge.id","edge.length","matched.type","matched.edge_index","matched.distance_along_edge","matched.distance_from_trace_point","matched.begin_route_discontinuity","matched.end_route_discontinuity"]} });
    if (before!==this.version(await this.request("/status",signal)) || !Array.isArray(result.matched_points) || !Array.isArray(result.edges)) throw new DriverMeasurementError(503,"DRIVER_MATCH_UNAVAILABLE");
    return { dataset:before, points:result.matched_points.map((p:Record<string,any>)=>{
      const e=Number.isInteger(p.edge_index) ? result.edges[p.edge_index] : undefined;
      const span=(e?.target_percent_along ?? 1)-(e?.source_percent_along ?? 0);
      return { edgeId:typeof e?.id==="string" ? e.id : Number.isSafeInteger(e?.id) ? String(e.id) : undefined,
        fraction:p.distance_along_edge, distanceM:p.distance_from_trace_point, matched:p.type==="matched",
        disconnected:!!p.begin_route_discontinuity || !!p.end_route_discontinuity,
        edgeLengthM: typeof e?.length==="number" && span>0 ? e.length*1000/span : undefined };
    }) };
  }
}

export interface DriverSettings { enabled: boolean; revocationEnabled?: boolean; databaseUrl?: string; token?: string; hashSecret?: string; ratePerMinute: number }
export function driverSettings(): DriverSettings {
  const enabled=process.env.DRIVER_MEASUREMENTS_ENABLED==="true";
  const revocationEnabled=process.env.DRIVER_MEASUREMENTS_REVOCATION_ENABLED==="true";
  const databaseUrl=process.env.DRIVER_MEASUREMENTS_DATABASE_URL, token=process.env.DRIVER_MEASUREMENTS_COP_TOKEN, hashSecret=process.env.DRIVER_MEASUREMENTS_HASH_SECRET;
  const ratePerMinute=Number(process.env.DRIVER_MEASUREMENTS_RATE_PER_MINUTE ?? 120);
  if ((enabled || revocationEnabled) && (!databaseUrl || !token || token.length<32 || !hashSecret || hashSecret.length<32 || !Number.isInteger(ratePerMinute) || ratePerMinute<1 || ratePerMinute>600)) throw new Error("Invalid driver-measurement configuration");
  return { enabled,revocationEnabled,databaseUrl,token,hashSecret,ratePerMinute };
}

export function registerDriverMeasurementRoutes(app: Express, config: SituationDataConfig, settings=driverSettings(),
  dependencies?: { store: DriverStore; matcher: DriverMatcher; now?:()=>number }): { close: ()=>Promise<void> } {
  // Body parser errors otherwise escape to Express's default HTML/error logging.
  app.use(PREFIX,(error:unknown,req:Request,res:Response,_next:NextFunction)=>{
    res.set("Cache-Control","no-store");
    const tooLarge=!!error && typeof error==="object" && "type" in error && error.type==="entity.too.large";
    problem(req,res,tooLarge?413:400,tooLarge?"DRIVER_PAYLOAD_TOO_LARGE":"DRIVER_MEASUREMENT_INVALID","Invalid driver measurement payload.");
  });
  const store=dependencies?.store ?? ((settings.enabled || settings.revocationEnabled) ? new PostgresDriverMeasurementStore(settings.databaseUrl!,settings.hashSecret!) : undefined);
  const matcher=dependencies?.matcher ?? (config.valhallaBaseUrl ? new ValhallaDriverMatcher(config.valhallaBaseUrl) : undefined);
  const now=dependencies?.now ?? Date.now;
  let minute=0, requests=0, inflight=0;
  const contributors=new Map<string,{at:number; count:number}>();
  const hashContributor=(id:string)=>createHmac("sha256",settings.hashSecret!).update(`cop:${id}`).digest("hex");
  function auth(req:Request,res:Response,revocationOnly=false): boolean {
    res.set("Cache-Control","no-store");
    if (req.get("origin")) { problem(req,res,403,"BROWSER_ACCESS_FORBIDDEN","Backend service access only."); return false; }
    const actual=Buffer.from(req.get("authorization")??""), expected=Buffer.from(`Bearer ${settings.token??""}`);
    if (!settings.token || actual.length!==expected.length || !timingSafeEqual(actual,expected)) { problem(req,res,401,"UNAUTHORIZED","COP measurement service authentication required."); return false; }
    const allowed=revocationOnly ? settings.enabled || settings.revocationEnabled : settings.enabled;
    if (!allowed || !store || (!revocationOnly && !matcher)) { problem(req,res,503,"DRIVER_MEASUREMENTS_DISABLED","Driver measurement operation is disabled."); return false; }
    const m=Math.floor(now()/60000); if (m!==minute) {minute=m;requests=0;}
    if (++requests>settings.ratePerMinute) { res.set("Retry-After","60"); problem(req,res,429,"DRIVER_RATE_LIMITED","Retry later without changing the batch identity."); return false; }
    return true;
  }
  const failure=(req:Request,res:Response,error:unknown)=>{
    const e=error instanceof DriverMeasurementError ? error : new DriverMeasurementError(503,"DRIVER_MEASUREMENTS_UNAVAILABLE");
    problem(req,res,e.status,e.code,"Driver measurement operation could not be completed.");
  };
  app.post(`${PREFIX}/batches`,async(req,res)=>{
    if (!auth(req,res)) return;
    try {
      const batch=parseDriverBatch(req.body,now());
      const digest=createHmac("sha256",settings.hashSecret!).update(`request:${JSON.stringify(batch)}`).digest("hex");
      const replay=await store!.lookup("cop",batch.batchId,digest);
      if (replay) {res.set("X-Idempotent-Replay","true");res.json(replay);return;}
      const contributor=hashContributor(batch.contributorIdDay);
      for (const [k,v] of contributors) if (now()-v.at>=60000) contributors.delete(k);
      const window=contributors.get(contributor)??{at:now(),count:0};
      if (++window.count>2) { res.set("Retry-After","60"); throw new DriverMeasurementError(429,"DRIVER_CONTRIBUTOR_RATE_LIMITED"); }
      contributors.set(contributor,window);
      if (inflight>=4) { res.set("Retry-After","15"); throw new DriverMeasurementError(429,"DRIVER_INTAKE_BUSY"); }
      inflight++;
      try {
        const sensorTrace=batch.points.every(p=>p.positionSource==="gps" && !p.reducedAccuracy && p.horizontalAccuracyM<=15);
        const matched=sensorTrace ? await matcher!.match(batch.points) : {dataset:await matcher!.dataset(),points:batch.points.map(()=>({matched:false,disconnected:true}))};
        const derived=deriveDriverIntervals(batch,matched);
        const receipt:DriverReceipt={contractVersion:DRIVER_CONTRACT,batchId:batch.batchId,receivedAt:new Date(now()).toISOString(),
          acceptedIntervalCount:derived.intervals.length,deduplicatedIntervalCount:0,rejectionCounts:derived.rejectionCounts,
          etaAccepted:derived.etaAccepted,applicationMode:"shadow_only",rawPositionsStored:false};
        res.status(200).json(await store!.commit("cop",contributor,digest,batch,derived.intervals,receipt));
      } finally { inflight--; }
    } catch (error) { failure(req,res,error); }
  });
  app.get(`${PREFIX}/aggregates`,async(req,res)=>{
    if (!auth(req,res)) return;
    try {
      if (Object.keys(req.query).some(k=>k!=="since")) invalid();
      const since=req.query.since===undefined ? new Date(now()-86400000).toISOString() : stamp(req.query.since);
      if (Date.parse(since)<now()-604800000 || Date.parse(since)>now()) invalid();
      const dataset=await matcher!.dataset();
      res.json({contractVersion:DRIVER_CONTRACT,applicationMode:"shadow_only",routingDataset:dataset,generatedAt:new Date(now()).toISOString(),
        source:"jizda_consented_gps",items:await store!.aggregates(dataset,since,new Date(now()).toISOString()),
        limits:{minimumAttestedContributors:5,minimumIntervals:10,maximumRows:1000},independentContributorsVerified:false});
    } catch(error) { failure(req,res,error); }
  });
  app.get(`${PREFIX}/quality`,async(req,res)=>{
    if (!auth(req,res)) return;
    try { res.json({contractVersion:DRIVER_CONTRACT,applicationMode:"shadow_only",etaEvidence:"client_reported_not_ground_truth",summary:await store!.quality(new Date(now()).toISOString())}); }
    catch(error) { failure(req,res,error); }
  });
  app.delete(`${PREFIX}/contributions`,async(req,res)=>{
    if (!auth(req,res,true)) return;
    try {
      const raw=object(req.body,["contractVersion","contributorIdDay"]);
      if (raw.contractVersion!==DRIVER_CONTRACT) invalid();
      const count=await store!.revoke("cop",hashContributor(opaque(raw.contributorIdDay)));
      res.json({contractVersion:DRIVER_CONTRACT,deletedBatchCount:count});
    } catch(error) { failure(req,res,error); }
  });
  return {close:()=>store?.close()??Promise.resolve()};
}
