/** Synthetic reference exercise of SECURITY_RESTORE; not a D1/R2 recovery service. */
import assert from 'node:assert/strict';
import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {ErasureTarget,ErasureIntent,ErasurePass,ErasureCompletion} from '../src/contracts/index.ts';
type Target=z.infer<typeof ErasureTarget>;
type Intent=z.infer<typeof ErasureIntent>;
type Pass=z.infer<typeof ErasurePass>;
type Completion=z.infer<typeof ErasureCompletion>;
const env='synthetic',owner='10101010-1010-4010-8010-101010101010';
const reflection='20202020-2020-4020-8020-202020202020',job='30303030-3030-4030-8030-303030303030';
// Canonical JSON for these ASCII/integer fixtures only; not a production JCS implementation.
function ordered(value:unknown):unknown {
  if(Array.isArray(value))return value.map(ordered);
  if(value!==null&&typeof value==='object')return Object.fromEntries(
    Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,ordered(v)]));
  return value;
}
const jcs=(value:unknown)=>JSON.stringify(ordered(value));
const digest=(value:unknown)=>createHash('sha256').update(jcs(value)).digest('hex');
const keys=new Map([['hmac-old',Buffer.alloc(32,1)],['hmac-current',Buffer.alloc(32,2)],
  ['recovery-old',Buffer.alloc(32,3)],['recovery-current',Buffer.alloc(32,4)]]);
function key(id:string){const value=keys.get(id);assert.ok(value,`missing key ${id}`);return value;}
const hmac=(id:string,value:unknown)=>createHmac('sha256',key(id)).update(jcs(value)).digest('hex');
function signed<T extends {hmacKeyId:string}>(kind:string,body:T){
  return {...body,operationMac:hmac(body.hmacKeyId,[env,kind,body])};
}
function verify(kind:string,value:{hmacKeyId:string;operationMac:string}){
  const {operationMac,...body}=value;
  assert.equal(operationMac,signed(kind,body).operationMac);
}
function aad(i:Omit<Intent,'operationMac'|'target'>,keyId:string){
  return Buffer.from(jcs([env,'erasure-target.v1',i.jobId,i.scope,i.subjectHmac,i.targetHmac,
    i.hmacKeyId,i.requestedAt,keyId]));
}
function seal(target:Target):Intent {
  const body={v:1 as const,jobId:job,scope:target.scope,hmacKeyId:'hmac-old',
    subjectHmac:hmac('hmac-old',['erasure-subject.v1',env,target.subjectId]),
    targetHmac:hmac('hmac-old',['erasure-target.v1',env,target]),
    receiptTokenHmac:null,requestedAt:'2026-10-01T00:00:00Z'};
  const keyId='recovery-old',nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(keyId),nonce);
  cipher.setAAD(aad(body,keyId));
  const data=Buffer.concat([cipher.update(jcs(target),'utf8'),cipher.final(),cipher.getAuthTag()]);
  return ErasureIntent.parse(signed('erasure-intent.v1',{...body,target:{v:1,alg:'A256GCM',
    keyId,nonce:nonce.toString('base64url'),data:data.toString('base64url')}}));
}
function open(value:Intent):Target {
  const i=ErasureIntent.parse(value);verify('erasure-intent.v1',i);
  const data=Buffer.from(i.target.data,'base64url');
  const decipher=createDecipheriv('aes-256-gcm',key(i.target.keyId),Buffer.from(i.target.nonce,'base64url'));
  decipher.setAAD(aad(i,i.target.keyId));decipher.setAuthTag(data.subarray(-16));
  const target=ErasureTarget.parse(JSON.parse(Buffer.concat([
    decipher.update(data.subarray(0,-16)),decipher.final()]).toString('utf8')));
  assert.equal(target.scope,i.scope);
  assert.equal(hmac(i.hmacKeyId,['erasure-subject.v1',env,target.subjectId]),i.subjectHmac);
  assert.equal(hmac(i.hmacKeyId,['erasure-target.v1',env,target]),i.targetHmac);
  return target;
}
const target:Target={scope:'reflection_revision',subjectId:owner,reflectionId:reflection,revision:2};
const intent=seal(target);
// No deletion_jobs row is present. Only the independent serialized intent survives.
const recovered=open(JSON.parse(JSON.stringify(intent)) as Intent);
assert.deepEqual(recovered,target);
const rows=[{owner,reflection,revision:1},{owner,reflection,revision:2},
  {owner,reflection,revision:3},{owner:job,reflection,revision:2}];
assert.equal(recovered.scope,'reflection_revision');
if(recovered.scope!=='reflection_revision')throw new Error('wrong fixture');
const survivors=rows.filter(r=>!(r.owner===recovered.subjectId&&r.reflection===recovered.reflectionId&&r.revision===recovered.revision));
assert.deepEqual(survivors,[rows[0],rows[2],rows[3]]);
assert.throws(()=>open({...intent,targetHmac:'f'.repeat(64)}));
const oldKey=key('recovery-old');keys.delete('recovery-old');
assert.throws(()=>open(intent),/missing key/);keys.set('recovery-old',oldKey);
assert.deepEqual(open(intent),target); // Current keys did not replace the retained referenced key.
const oldMac=key('hmac-old');keys.delete('hmac-old');
assert.throws(()=>open(intent),/missing key/);keys.set('hmac-old',oldMac);
assert.deepEqual(open(intent),target);

const day=86400000;
function begin(previous:Completion|null,at:string):Pass {
  return ErasurePass.parse(signed('erasure-pass.v1',{v:1,jobId:job,revision:(previous?.revision??0)+1,
    intentSha256:digest(intent),previousCompletionSha256:previous?digest(previous):null,
    startedAt:at,hmacKeyId:'hmac-current'}));
}
function finish(pass:Pass,previous:Completion|null,at:string):Completion {
  const erased=Date.parse(at);
  const backup=Math.max(previous?Date.parse(previous.backupExpiresBy):0,erased+30*day);
  const purge=Math.max(previous?Date.parse(previous.purgeAfter):0,erased+45*day,backup+15*day);
  return ErasureCompletion.parse(signed('erasure-completion.v1',{v:1,jobId:job,revision:pass.revision,
    passSha256:digest(pass),erasedAt:at,backupExpiresBy:new Date(backup).toISOString(),
    purgeAfter:new Date(purge).toISOString(),intentSha256:digest(intent),hmacKeyId:'hmac-current'}));
}
function inspect(passes:Pass[],completions:Completion[]){
  let previous:Completion|null=null;
  for(const [index,pass] of [...passes].sort((a,b)=>a.revision-b.revision).entries()){
    ErasurePass.parse(pass);verify('erasure-pass.v1',pass);
    assert.equal(pass.jobId,intent.jobId);assert.equal(pass.revision,index+1);
    assert.equal(pass.intentSha256,digest(intent));
    assert.equal(pass.previousCompletionSha256,previous?digest(previous):null);
    const matches=completions.filter(c=>c.revision===pass.revision);assert.ok(matches.length<=1);
    const complete=matches[0];
    if(!complete){assert.equal(index,passes.length-1);assert.equal(completions.length,index);return null;}
    ErasureCompletion.parse(complete);verify('erasure-completion.v1',complete);
    assert.equal(complete.jobId,intent.jobId);assert.equal(complete.intentSha256,digest(intent));
    assert.equal(complete.passSha256,digest(pass));
    assert.ok(Date.parse(complete.erasedAt)>=Date.parse(pass.startedAt));
    const minimum=finish(pass,previous,complete.erasedAt);
    assert.ok(Date.parse(complete.backupExpiresBy)>=Date.parse(minimum.backupExpiresBy));
    assert.ok(Date.parse(complete.purgeAfter)>=Math.max(Date.parse(minimum.purgeAfter),Date.parse(complete.backupExpiresBy)+15*day));
    previous=complete;
  }
  assert.equal(completions.length,passes.length);return previous;
}
const first=begin(null,'2026-10-01T00:00:00Z');
const c1=finish(first,null,'2026-10-01T00:01:00Z');
const second=begin(c1,'2026-10-20T00:00:00Z');
assert.equal(inspect([first,second],[c1]),null); // Older completion cannot authorize purge during replay.
const c2=finish(second,c1,'2026-10-20T00:01:00Z');
assert.equal(inspect([second,first],[c2,c1])?.revision,2); // R2 listing order is irrelevant.
assert.equal(c2.backupExpiresBy,'2026-11-19T00:01:00.000Z');
assert.equal(c2.purgeAfter,'2026-12-04T00:01:00.000Z');
const third=begin(c2,'2026-11-10T00:00:00Z'),c3=finish(third,c2,'2026-11-10T00:01:00Z');
assert.equal(inspect([third,first,second],[c2,c3,c1])?.purgeAfter,'2026-12-25T00:01:00.000Z');
const {operationMac:ignored,...body}=c3;void ignored;
assert.throws(()=>inspect([first,second,third],[c1,c2,signed('erasure-completion.v1',{...body,purgeAfter:c1.purgeAfter})]));
assert.throws(()=>inspect([first,third],[c1,c3]));
const objectKeys=[first,second,third].map(p=>`erasures/v1/${p.jobId}/passes/${p.revision}/complete.json`);
assert.equal(new Set(objectKeys).size,3);
console.log('Erasure reference checks passed: missing D1 job, exact revision/owner, retained older keys, authenticated completion chain, pending replay and repeated deadline extension. No D1/R2 service exercised.');
