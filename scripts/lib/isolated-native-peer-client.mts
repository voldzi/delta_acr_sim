/**
 * OFFLINE FIXTURE ABI ONLY. No socket, process, database, provider or app wiring.
 * The source wrapper requires AF_UNIX SOCK_SEQPACKET plus Linux credentials;
 * Node net's stream transport is not equivalent and is intentionally absent.
 * Every successful value below remains an isolated fixture acknowledgement,
 * never a runtime/identity/admission/restore or production authority proof.
 */
import { createHash, randomUUID } from "node:crypto";

export type PeerOwner = "sim_ai_router" | "sim_driver_measurements";
export type PeerMethod = "current" | "admit" | "begin_commit" | "complete" | "mark_indeterminate" | "drain";
export interface Cas {
  readonly root_generation:number; readonly checkpoint_id:string; readonly checkpoint_generation:number;
  readonly checkpoint_digest:string; readonly frontier_sequence:number; readonly frontier_digest:string;
  readonly binding_digest:string; readonly scope_ref:string;
  readonly checkpoint_kind:"synthetic-actor-local-not-owner-replay";
}
export interface Lease { readonly lease_id:string; readonly registered_digest:string; readonly historical:boolean }
export interface Permit { readonly permit_id:string; readonly lease_id:string; readonly registered_digest:string }
export interface EvidenceReference { readonly evidenceId:string; readonly recordDigest:string }
export interface TypedRefs {
  readonly "identity-ownership":EvidenceReference; readonly "retention-decision":EvidenceReference;
  readonly "report-protection":EvidenceReference; readonly "operation-schema":EvidenceReference;
}
export interface Drain {
  readonly state:"pending"|"drained"; readonly pending_count:number; readonly fence_id:string;
  readonly frontier_sequence:number; readonly frontier_digest:string; readonly owner:PeerOwner;
}
export interface PeerArgs {
  current:{readonly handle:string};
  admit:{readonly handle:string;readonly refs:TypedRefs;readonly cas:Cas};
  begin_commit:{readonly lease:Lease;readonly cas:Cas};
  complete:{readonly lease:Lease;readonly terminal_ref:EvidenceReference};
  mark_indeterminate:{readonly lease:Lease;readonly reason:"timeout"|"disconnect"|"unknown"};
  drain:{readonly handle:string;readonly cas:Cas};
}
export interface PeerResults {
  current:Cas; admit:Lease; begin_commit:Permit;
  complete:"known-terminal-recorded"|"historical-terminal-ack";
  mark_indeterminate:null; drain:Drain;
}
export interface PeerRequest<M extends PeerMethod=PeerMethod> {
  readonly protocol:"cop-actor-peer-isolated-v1"; readonly mode:"isolated-fixture-only";
  readonly owner:PeerOwner; readonly requestId:string; readonly method:M; readonly args:PeerArgs[M];
}
export interface FalseFlags {
  readonly productionAuthorization:false;readonly productionGo:false;readonly actualLinuxAcceptance:false;
  readonly actualRuntimeImageAttestation:false;readonly actualRootEnrollment:false;readonly actualIdentity:false;
  readonly actualProvider:false;readonly actualRestore:false;readonly ownerWideReplayComplete:false;readonly actualSimPreservation:false;
}
export interface FixtureResponse<M extends PeerMethod=PeerMethod> extends FalseFlags {
  readonly mode:"isolated-reference-response-only";readonly requestId:string;
  readonly scopeVersion:3;readonly scopeName:"cop_jizda_preserve_shared_identity_sim";readonly result:PeerResults[M];
}
export type FixtureCodecErrorCode="INVALID_PACKET"|"INVALID_JSON"|"DUPLICATE_KEY"|"FLOAT_TOKEN"|"UNSAFE_INTEGER"|"DEPTH_LIMIT"|
  "INVALID_REQUEST"|"INVALID_RESPONSE"|"BINDING_MISMATCH"|"CORRELATION_MISMATCH"|"UNSUPPORTED_CONTEXT"|"ISOLATED_MODE_REQUIRED"|"CAPACITY_LIMIT";
export class FixtureCodecError extends Error {
  constructor(readonly code:FixtureCodecErrorCode){super(code);this.name="FixtureCodecError";}
}
export class FixtureUnsupportedError extends FixtureCodecError {
  constructor(){super("UNSUPPORTED_CONTEXT");this.name="FixtureUnsupportedError";}
}
export class FixtureIndeterminateError extends Error {
  readonly code="INDETERMINATE" as const;
  constructor(readonly reason:"CALLER_DEADLINE"|"CALLER_ABORTED"|"EXCHANGE_UNKNOWN"){
    super("INDETERMINATE");this.name="FixtureIndeterminateError";
  }
}
const LIMIT=16_384,MAX_DEPTH=16,MAX_CONTEXTS=128,MAX_INFLIGHT=4;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
const FLAGS=["productionAuthorization","productionGo","actualLinuxAcceptance","actualRuntimeImageAttestation","actualRootEnrollment","actualIdentity","actualProvider","actualRestore","ownerWideReplayComplete","actualSimPreservation"] as const;
const CAS_KEYS=["root_generation","checkpoint_id","checkpoint_generation","checkpoint_digest","frontier_sequence","frontier_digest","binding_digest","scope_ref","checkpoint_kind"] as const;
const METHODS:PeerMethod[]=["current","admit","begin_commit","complete","mark_indeterminate","drain"];
function need(condition:unknown,code:FixtureCodecErrorCode):asserts condition{if(!condition)throw new FixtureCodecError(code);}
function record(value:unknown,keys:readonly string[],code:FixtureCodecErrorCode):Record<string,unknown>{
  need(value!==null&&typeof value==="object"&&!Array.isArray(value),code);
  const prototype=Object.getPrototypeOf(value);need(prototype===Object.prototype||prototype===null,code);
  const names=Reflect.ownKeys(value);need(names.length===keys.length&&names.every(k=>typeof k==="string"&&keys.includes(k)),code);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  need(keys.every(k=>descriptors[k]&&"value" in descriptors[k]&&descriptors[k].enumerable),code);
  return value as Record<string,unknown>;
}
const uuid=(value:unknown,code:FixtureCodecErrorCode):string=>{need(typeof value==="string"&&UUID.test(value),code);return value;};
const digest=(value:unknown,code:FixtureCodecErrorCode):string=>{need(typeof value==="string"&&DIGEST.test(value),code);return value;};
const counter=(value:unknown,code:FixtureCodecErrorCode):number=>{need(typeof value==="number"&&Number.isSafeInteger(value)&&value>=0,code);return value;};
function freeze<T>(value:T):Readonly<T>{
  if(value!==null&&typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}

/** Preserve packet lexical restrictions BEFORE JSON.parse can lose precision or duplicate keys. */
function parsePacket(bytes:Uint8Array):unknown{
  need(bytes instanceof Uint8Array&&bytes.byteLength>0&&bytes.byteLength<=LIMIT,"INVALID_PACKET");
  let text:string;try{text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new FixtureCodecError("INVALID_PACKET");}
  let at=0;
  const whitespace=()=>{while(at<text.length&&/[\x20\x09\x0a\x0d]/u.test(text[at]!))at++;};
  function string():string{
    need(text[at]==='"',"INVALID_JSON");const start=at++;
    while(at<text.length){const ch=text[at++]!;
      if(ch==='"'){try{return JSON.parse(text.slice(start,at)) as string;}catch{throw new FixtureCodecError("INVALID_JSON");}}
      need(ch.charCodeAt(0)>=0x20,"INVALID_JSON");
      if(ch==='\\'){need(at<text.length,"INVALID_JSON");const escaped=text[at++]!;
        if(escaped==='u'){need(/^[a-fA-F0-9]{4}$/u.test(text.slice(at,at+4)),"INVALID_JSON");at+=4;}
        else need('"\\/bfnrt'.includes(escaped),"INVALID_JSON");}
    }throw new FixtureCodecError("INVALID_JSON");
  }
  function value(depth:number):unknown{
    need(depth<=MAX_DEPTH,"DEPTH_LIMIT");whitespace();const ch=text[at];
    if(ch==='"')return string();
    if(ch==='{'){
      at++;whitespace();const out=Object.create(null) as Record<string,unknown>,seen=new Set<string>();
      if(text[at]==='}'){at++;return out;}
      while(at<text.length){whitespace();const key=string();need(!seen.has(key),"DUPLICATE_KEY");seen.add(key);whitespace();need(text[at++]===':',"INVALID_JSON");
        out[key]=value(depth+1);whitespace();const end=text[at++];if(end==='}')return out;need(end===',',"INVALID_JSON");}
      throw new FixtureCodecError("INVALID_JSON");
    }
    if(ch==='['){at++;whitespace();const out:unknown[]=[];if(text[at]===']'){at++;return out;}
      while(at<text.length){out.push(value(depth+1));whitespace();const end=text[at++];if(end===']')return out;need(end===',',"INVALID_JSON");}throw new FixtureCodecError("INVALID_JSON");}
    for(const [literal,parsed]of [["true",true],["false",false],["null",null]] as const){if(text.startsWith(literal,at)){at+=literal.length;return parsed;}}
    const numeric=/^-?(?:0|[1-9][0-9]*)/u.exec(text.slice(at));need(numeric,"INVALID_JSON");at+=numeric[0].length;
    need(!/[.eE]/u.test(text[at]??""),"FLOAT_TOKEN");const integer=BigInt(numeric[0]);
    need(integer>=-BigInt(Number.MAX_SAFE_INTEGER)&&integer<=BigInt(Number.MAX_SAFE_INTEGER),"UNSAFE_INTEGER");return Number(integer);
  }
  const result=value(0);whitespace();need(at===text.length,"INVALID_JSON");return result;
}
function cas(value:unknown,code:FixtureCodecErrorCode):Cas{
  const v=record(value,CAS_KEYS,code);need(v.checkpoint_kind==="synthetic-actor-local-not-owner-replay",code);
  return freeze({root_generation:counter(v.root_generation,code),checkpoint_id:uuid(v.checkpoint_id,code),checkpoint_generation:counter(v.checkpoint_generation,code),
    checkpoint_digest:digest(v.checkpoint_digest,code),frontier_sequence:counter(v.frontier_sequence,code),frontier_digest:digest(v.frontier_digest,code),
    binding_digest:digest(v.binding_digest,code),scope_ref:uuid(v.scope_ref,code),checkpoint_kind:"synthetic-actor-local-not-owner-replay" as const});
}
function lease(value:unknown,code:FixtureCodecErrorCode):Lease{
  const v=record(value,["lease_id","registered_digest","historical"],code);need(typeof v.historical==="boolean",code);
  return freeze({lease_id:uuid(v.lease_id,code),registered_digest:digest(v.registered_digest,code),historical:v.historical});
}
function reference(value:unknown,code:FixtureCodecErrorCode):EvidenceReference{
  const v=record(value,["evidenceId","recordDigest"],code);return freeze({evidenceId:uuid(v.evidenceId,code),recordDigest:digest(v.recordDigest,code)});
}
function refs(value:unknown,code:FixtureCodecErrorCode):TypedRefs{
  const v=record(value,["identity-ownership","retention-decision","report-protection","operation-schema"],code);
  return freeze({"identity-ownership":reference(v["identity-ownership"],code),"retention-decision":reference(v["retention-decision"],code),
    "report-protection":reference(v["report-protection"],code),"operation-schema":reference(v["operation-schema"],code)});
}
function request(value:unknown):PeerRequest{
  const v=record(value,["protocol","mode","owner","requestId","method","args"],"INVALID_REQUEST");
  need(v.mode==="isolated-fixture-only","ISOLATED_MODE_REQUIRED");
  need(v.protocol==="cop-actor-peer-isolated-v1"&&(v.owner==="sim_ai_router"||v.owner==="sim_driver_measurements")&&METHODS.includes(v.method as PeerMethod),"INVALID_REQUEST");
  const method=v.method as PeerMethod,code="INVALID_REQUEST" as const;let args:PeerArgs[PeerMethod];
  switch(method){
    case "current":{const a=record(v.args,["handle"],code);args={handle:uuid(a.handle,code)};break;}
    case "admit":{const a=record(v.args,["handle","refs","cas"],code),handle=uuid(a.handle,code),c=cas(a.cas,code);need(c.scope_ref===handle,code);args={handle,refs:refs(a.refs,code),cas:c};break;}
    case "begin_commit":{const a=record(v.args,["lease","cas"],code);args={lease:lease(a.lease,code),cas:cas(a.cas,code)};break;}
    case "complete":{const a=record(v.args,["lease","terminal_ref"],code);args={lease:lease(a.lease,code),terminal_ref:reference(a.terminal_ref,code)};break;}
    case "mark_indeterminate":{const a=record(v.args,["lease","reason"],code);need(a.reason==="timeout"||a.reason==="disconnect"||a.reason==="unknown",code);args={lease:lease(a.lease,code),reason:a.reason};break;}
    case "drain":{const a=record(v.args,["handle","cas"],code),handle=uuid(a.handle,code),c=cas(a.cas,code);need(c.scope_ref===handle,code);args={handle,cas:c};break;}
  }
  return freeze({protocol:"cop-actor-peer-isolated-v1",mode:"isolated-fixture-only",owner:v.owner,requestId:uuid(v.requestId,code),method,args});
}
export function encodeFixtureRequest(value:PeerRequest):Uint8Array{
  const normalized=request(value),bytes=new TextEncoder().encode(JSON.stringify(normalized));need(bytes.byteLength<=LIMIT,"INVALID_PACKET");return bytes;
}
export function decodeFixtureRequest(bytes:Uint8Array):PeerRequest{return request(parsePacket(bytes));}
export function decodeFixtureResponse<M extends PeerMethod>(bytes:Uint8Array,expectedRequest:PeerRequest<M>,fixedBindingDigest:string):FixtureResponse<M>{
  const expected=request(expectedRequest);digest(fixedBindingDigest,"BINDING_MISMATCH");
  const v=record(parsePacket(bytes),["mode","requestId","result","scopeVersion","scopeName",...FLAGS],"INVALID_RESPONSE");
  need(v.mode==="isolated-reference-response-only"&&v.scopeVersion===3&&v.scopeName==="cop_jizda_preserve_shared_identity_sim"&&FLAGS.every(flag=>v[flag]===false),"INVALID_RESPONSE");
  need(uuid(v.requestId,"INVALID_RESPONSE")===expected.requestId,"CORRELATION_MISMATCH");let result:PeerResults[PeerMethod];
  const a=expected.args as any,code="INVALID_RESPONSE" as const;
  switch(expected.method){
    case "current":{const c=cas(v.result,code);need(c.binding_digest===fixedBindingDigest,"BINDING_MISMATCH");need(c.scope_ref===a.handle,"BINDING_MISMATCH");result=c;break;}
    case "admit":need(a.cas.binding_digest===fixedBindingDigest,"BINDING_MISMATCH");result=lease(v.result,code);break;
    case "begin_commit":{
      need(a.cas.binding_digest===fixedBindingDigest,"BINDING_MISMATCH");const p=record(v.result,["permit_id","lease_id","registered_digest"],code);
      const permit={permit_id:uuid(p.permit_id,code),lease_id:uuid(p.lease_id,code),registered_digest:digest(p.registered_digest,code)};
      need(permit.lease_id===a.lease.lease_id,"BINDING_MISMATCH");
      const expectedDigest=createHash("sha256").update(JSON.stringify({lease:a.lease.registered_digest,permit:permit.permit_id})).digest("hex");
      need(permit.registered_digest===expectedDigest,"BINDING_MISMATCH");result=freeze(permit);break;
    }
    case "complete":need(v.result==="known-terminal-recorded"||v.result==="historical-terminal-ack",code);result=v.result;break;
    case "mark_indeterminate":need(v.result===null,code);result=null;break;
    case "drain":{
      need(a.cas.binding_digest===fixedBindingDigest,"BINDING_MISMATCH");const d=record(v.result,["state","pending_count","fence_id","frontier_sequence","frontier_digest","owner"],code);
      need(d.state==="pending"||d.state==="drained",code);const count=counter(d.pending_count,code),seq=counter(d.frontier_sequence,code),frontier=digest(d.frontier_digest,code);
      need((d.state==="drained")===(count===0),code);need(d.owner===expected.owner&&seq===a.cas.frontier_sequence&&frontier===a.cas.frontier_digest,"BINDING_MISMATCH");
      result=freeze({state:d.state as Drain["state"],pending_count:count,fence_id:uuid(d.fence_id,code),frontier_sequence:seq,frontier_digest:frontier,owner:expected.owner});break;
    }
  }
  return freeze({...v,result}) as unknown as FixtureResponse<M>;
}

export type FixtureExchange=(packet:Uint8Array,signal:AbortSignal)=>Promise<Uint8Array>;
export interface FixtureScheduler {set(callback:()=>void,milliseconds:number):unknown;clear(handle:unknown):void}
export interface FixtureClientOptions {
  readonly mode:"isolated-fixture-only";readonly owner:PeerOwner;readonly bindingDigest:string;
  readonly exchange:FixtureExchange;readonly deadlineMs:number;readonly scheduler?:FixtureScheduler;
}
export interface FixtureCallOptions {readonly signal?:AbortSignal;readonly requestId?:string}
interface KnownLease {lease:Lease;handle:string;admissionCas:Cas;completed:boolean;unknown:boolean;permitKnown:boolean}
const sameCas=(a:Cas,b:Cas)=>CAS_KEYS.every(key=>a[key]===b[key]);

export class IsolatedFixtureClient {
  readonly #owner:PeerOwner;readonly #binding:string;readonly #exchange:FixtureExchange;readonly #deadline:number;readonly #scheduler:FixtureScheduler;
  readonly #current=new Map<string,Cas>();readonly #leases=new Map<string,KnownLease>();readonly #handleLeases=new Map<string,string>();readonly #unknownAdmissions=new Set<string>();
  #inflight=0;
  constructor(options:FixtureClientOptions){
    const optional=options!==null&&typeof options==="object"&&Object.hasOwn(options,"scheduler");
    const o=record(options,["mode","owner","bindingDigest","exchange","deadlineMs",...(optional?["scheduler"]:[])],"INVALID_REQUEST");
    need(o.mode==="isolated-fixture-only","ISOLATED_MODE_REQUIRED");need(o.owner==="sim_ai_router"||o.owner==="sim_driver_measurements","INVALID_REQUEST");
    need(typeof o.exchange==="function"&&Number.isSafeInteger(o.deadlineMs)&&(o.deadlineMs as number)>=1&&(o.deadlineMs as number)<=1000,"INVALID_REQUEST");
    this.#owner=o.owner;this.#binding=digest(o.bindingDigest,"BINDING_MISMATCH");this.#exchange=o.exchange as FixtureExchange;this.#deadline=o.deadlineMs as number;
    if(optional){const s=record(o.scheduler,["set","clear"],"INVALID_REQUEST");need(typeof s.set==="function"&&typeof s.clear==="function","INVALID_REQUEST");
      this.#scheduler=Object.freeze({set:(s.set as FixtureScheduler["set"]).bind(o.scheduler),clear:(s.clear as FixtureScheduler["clear"]).bind(o.scheduler)});
    }else this.#scheduler=Object.freeze({set:(cb:()=>void,ms:number)=>setTimeout(cb,ms),clear:(handle:unknown)=>clearTimeout(handle as ReturnType<typeof setTimeout>)});
    Object.freeze(this);
  }
  get productionReady():false{return false;}
  get mode():"isolated-fixture-only"{return "isolated-fixture-only";}
  get owner():PeerOwner{return this.#owner;}
  #context(req:PeerRequest):void{
    const a=req.args as any;
    if(req.method==="current"){if(!this.#current.has(a.handle)&&this.#current.size>=MAX_CONTEXTS)throw new FixtureCodecError("CAPACITY_LIMIT");return;}
    if(req.method==="admit"||req.method==="drain"){
      const observed=this.#current.get(a.handle);if(!observed||!sameCas(observed,a.cas)||a.cas.binding_digest!==this.#binding)throw new FixtureUnsupportedError();
      if(req.method==="admit"&&(this.#unknownAdmissions.has(a.handle)||(!this.#handleLeases.has(a.handle)&&this.#leases.size>=MAX_CONTEXTS)))throw new FixtureUnsupportedError();return;
    }
    const known=this.#leases.get(a.lease.lease_id);
    if(!known||known.lease.registered_digest!==a.lease.registered_digest||known.lease.historical!==a.lease.historical)throw new FixtureUnsupportedError();
    if(req.method==="begin_commit"){
      const observed=this.#current.get(known.handle);
      if(known.lease.historical||known.completed||known.unknown||known.permitKnown||!observed||!sameCas(observed,a.cas)||!sameCas(known.admissionCas,a.cas))throw new FixtureUnsupportedError();
    }else if(req.method==="mark_indeterminate"&&known.completed)throw new FixtureUnsupportedError();
  }
  #observe(req:PeerRequest,response:FixtureResponse):void{
    const a=req.args as any;
    if(req.method==="current"){
      const c=response.result as Cas,prior=this.#current.get(a.handle);
      if(!prior&&this.#current.size>=MAX_CONTEXTS)throw new FixtureCodecError("CAPACITY_LIMIT");
      if(prior&&(c.root_generation<prior.root_generation||c.checkpoint_generation<prior.checkpoint_generation||c.frontier_sequence<prior.frontier_sequence||
        c.root_generation===prior.root_generation&&c.checkpoint_generation===prior.checkpoint_generation&&(c.checkpoint_id!==prior.checkpoint_id||c.checkpoint_digest!==prior.checkpoint_digest)||
        c.frontier_sequence===prior.frontier_sequence&&c.frontier_digest!==prior.frontier_digest))throw new FixtureUnsupportedError();
      this.#current.set(a.handle,c);
    }else if(req.method==="admit"){
      const l=response.result as Lease,existingId=this.#handleLeases.get(a.handle),existing=existingId?this.#leases.get(existingId):undefined,knownId=this.#leases.get(l.lease_id);
      if(knownId&&(knownId.handle!==a.handle||knownId.lease.registered_digest!==l.registered_digest))throw new FixtureUnsupportedError();
      if(!knownId&&this.#leases.size>=MAX_CONTEXTS)throw new FixtureCodecError("CAPACITY_LIMIT");
      if(existing&&(existing.lease.lease_id!==l.lease_id||existing.lease.registered_digest!==l.registered_digest))throw new FixtureUnsupportedError();
      if(existing?.lease.historical&&!l.historical)throw new FixtureUnsupportedError();
      this.#leases.set(l.lease_id,{lease:l,handle:a.handle,admissionCas:a.cas,completed:existing?.completed??false,unknown:existing?.unknown??false,permitKnown:existing?.permitKnown??false});this.#handleLeases.set(a.handle,l.lease_id);
    }else if(req.method==="begin_commit")this.#leases.get(a.lease.lease_id)!.permitKnown=true;
    else if(req.method==="complete")this.#leases.get(a.lease.lease_id)!.completed=true;
    else if(req.method==="mark_indeterminate")this.#leases.get(a.lease.lease_id)!.unknown=true;
  }
  async call<M extends PeerMethod>(method:M,args:PeerArgs[M],options:FixtureCallOptions={}):Promise<FixtureResponse<M>>{
    const optionKeys=Reflect.ownKeys(options);need(optionKeys.every(key=>key==="signal"||key==="requestId"),"INVALID_REQUEST");
    if(options.signal!==undefined)need(options.signal instanceof AbortSignal,"INVALID_REQUEST");
    const normalized=request({protocol:"cop-actor-peer-isolated-v1",mode:"isolated-fixture-only",owner:this.#owner,requestId:options.requestId??randomUUID(),method,args}) as PeerRequest<M>;
    this.#context(normalized);if(this.#inflight>=MAX_INFLIGHT)throw new FixtureCodecError("CAPACITY_LIMIT");
    if(options.signal?.aborted)throw new FixtureIndeterminateError("CALLER_ABORTED");
    this.#inflight++;const controller=new AbortController();let timer:unknown,installed=false,abort:(()=>void)|undefined,dispatched=false,slotHeld=true;
    const releaseSlot=()=>{if(slotHeld){slotHeld=false;this.#inflight--;}};
    try{
      const canceled=new Promise<never>((_resolve,reject)=>{
        const fail=(reason:"CALLER_DEADLINE"|"CALLER_ABORTED")=>{controller.abort();reject(new FixtureIndeterminateError(reason));};
        timer=this.#scheduler.set(()=>fail("CALLER_DEADLINE"),this.#deadline);installed=true;
        abort=()=>fail("CALLER_ABORTED");options.signal?.addEventListener("abort",abort,{once:true});
      });
      const operation=Promise.resolve().then(()=>{if(controller.signal.aborted)throw new FixtureIndeterminateError("CALLER_DEADLINE");dispatched=true;return this.#exchange(encodeFixtureRequest(normalized),controller.signal);});
      // A caller deadline is not known transport/effect settlement. Keep its
      // capacity slot until the injected exchange really resolves or rejects.
      void operation.then(releaseSlot,releaseSlot);
      let packet:Uint8Array;
      try{packet=await Promise.race([operation,canceled]);}catch(error){if(error instanceof FixtureIndeterminateError)throw error;throw new FixtureIndeterminateError("EXCHANGE_UNKNOWN");}
      if(controller.signal.aborted)throw new FixtureIndeterminateError("CALLER_DEADLINE");
      let decoded:FixtureResponse<M>;try{decoded=decodeFixtureResponse(packet,normalized,this.#binding);this.#observe(normalized,decoded);}catch{throw new FixtureIndeterminateError("EXCHANGE_UNKNOWN");}
      return decoded;
    }catch(error){
      if(dispatched&&normalized.method==="admit")this.#unknownAdmissions.add((normalized.args as PeerArgs["admit"]).handle);
      if(dispatched&&normalized.method==="begin_commit"){const known=this.#leases.get((normalized.args as PeerArgs["begin_commit"]).lease.lease_id);if(known)known.unknown=true;}
      throw error instanceof FixtureIndeterminateError?error:new FixtureIndeterminateError("EXCHANGE_UNKNOWN");
    }finally{if(installed)this.#scheduler.clear(timer);if(abort)options.signal?.removeEventListener("abort",abort);if(!dispatched)releaseSlot();}
  }
  current(handle:string,options?:FixtureCallOptions){return this.call("current",{handle},options);}
  admit(handle:string,refs:TypedRefs,cas:Cas,options?:FixtureCallOptions){return this.call("admit",{handle,refs,cas},options);}
  begin_commit(lease:Lease,cas:Cas,options?:FixtureCallOptions){return this.call("begin_commit",{lease,cas},options);}
  complete(lease:Lease,terminal_ref:EvidenceReference,options?:FixtureCallOptions){return this.call("complete",{lease,terminal_ref},options);}
  mark_indeterminate(lease:Lease,reason:PeerArgs["mark_indeterminate"]["reason"],options?:FixtureCallOptions){return this.call("mark_indeterminate",{lease,reason},options);}
  drain(handle:string,cas:Cas,options?:FixtureCallOptions){return this.call("drain",{handle,cas},options);}
}
export function negativeProductionProofBridge():Readonly<{compatible:false;productionReady:false;reason:"ISOLATED_PROTOCOL_NOT_RUNTIME_AUTHORITY"}>{
  return Object.freeze({compatible:false,productionReady:false,reason:"ISOLATED_PROTOCOL_NOT_RUNTIME_AUTHORITY"});
}
