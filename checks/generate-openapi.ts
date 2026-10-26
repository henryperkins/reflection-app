/** Specification projection only. Does not create application routes. */
import {writeFileSync} from 'node:fs';
import {z} from 'zod';
import YAML from 'yaml';
import {apiSchemas,ModelCandidate} from '../docs/architecture/DOMAIN_CONTRACTS.ts';
type Name=keyof typeof apiSchemas;
type Op={method:'get'|'post'|'put'|'delete';path:string;id:string;body?:Name;out?:Name;
  status?:number;public?:boolean;recent?:boolean;cas?:boolean;key?:boolean;description:string;query?:string[]};
const operations:Op[]=[
 {method:'post',path:'/auth/options',id:'authOptions',body:'AuthBegin',out:'AuthOptions',public:true,description:'10/10 min/IP. Same-origin challenge cookie. Register/authenticate public; add/reauthenticate require current session; add also requires recent passkey authentication and CSRF. Five-minute single-use challenge; no private record.'},
 {method:'post',path:'/auth/register',id:'register',body:'RegisterFinish',out:'AuthResult',public:true,description:'3 registrations/day/IP. Consume verified challenge and fence proposed account/key/credential/false permission in D1; confirm independent identity checkpoint before final D1 apply and session issuance. Also completes add/recover purpose with bound current subject; purpose cannot be substituted. Sets __Host-session; returns recovery codes only when created/rotated. Uncertain checkpoint completion returns503; never issues an uncommitted session.'},
 {method:'post',path:'/auth/authenticate',id:'authenticate',body:'AuthenticateFinish',out:'AuthResult',public:true,description:'10/10 min/IP. Verify library challenge/origin/RP/UV/signature/userHandle. Consume challenge, update counter, issue session atomically. Generic 401 on failure; empty recoveryCodes.'},
 {method:'post',path:'/auth/recover',id:'recoverIdentity',body:'Recover',out:'RecoveryGrant',public:true,description:'5 failures/hour/IP and handle. Verify unused recovery code, then fence and checkpoint its consumption through the security saga. Final D1 apply revokes sessions and creates browser-bound registration challenge only after independent checkpoint durability. Grants no data access. 401 generic failure;503 while durability is uncertain.'},
 {method:'post',path:'/auth/recovery/ack',id:'acknowledgeRecovery',body:'Empty',status:204,description:'Checkpoint acknowledgement of saved recovery factors through the security saga; required before first personal persistence/generation. Idempotent;503 if checkpoint durability cannot be confirmed.'},
 {method:'post',path:'/auth/logout',id:'logout',body:'Empty',status:204,description:'Delete current session and expire cookie. Idempotent even if cookie absent. Origin checked. Client clears private memory and notifies tabs.'},
 {method:'post',path:'/auth/logout-all',id:'logoutAll',body:'Empty',status:204,description:'Increment auth epoch and revoke all sessions atomically; expire current cookie. Does not cancel previously authorized generation.'},
 {method:'get',path:'/auth/credentials',id:'credentials',out:'Credentials',description:'Owned credential metadata; no public keys or private identifiers beyond removable credential ID. Limit 10.'},
 {method:'delete',path:'/auth/credentials/{credentialId}',id:'removeCredential',status:204,recent:true,description:'Recent passkey auth required; cannot remove last credential (409). Security saga durably checkpoints removal before final D1 apply, auth-epoch advance and replacement caller session. No success on uncertain checkpoint write. No identity merge.'},
 {method:'post',path:'/auth/recovery-codes',id:'rotateRecoveryCodes',body:'Empty',out:'RecoveryCodes',recent:true,description:'Security saga checkpoints replacement code verifiers and handle before invalidating old codes and returning ten new codes once. Never retry after losing response: sign in with a passkey, reauthenticate and rotate again. Secret response no-store.'},
 {method:'get',path:'/me',id:'me',out:'SessionView',description:'Current account/session/CSRF/consent/quota summary. No profile biography. 120/min/account read budget.'},
 {method:'put',path:'/permissions/model',id:'setModelPermission',body:'PermissionWrite',out:'Permission',cas:true,key:true,description:'If-Match permission revision. Append permission revision and update account pointer; revocation fences in-flight requests/releases quota in same transaction. Saving is not consent.'},
 {method:'post',path:'/context-grants',id:'grantContext',body:'GrantWrite',out:'Grant',key:true,description:'Allow only exact owned available edition/current reflection revision. Eligibility is separate from selection. No transmission. 30 mutations/min/account.'},
 {method:'get',path:'/context-grants',id:'listContextGrants',out:'GrantPage',query:['cursor','limit','editionId'],description:'Owned grant IDs, revisions, state and source references; keyset created_at/id, default20/max50. Include revoked grants for settings. No provider call.'},
 {method:'delete',path:'/context-grants/{grantId}',id:'revokeContext',out:'Grant',cas:true,key:true,description:'CAS grant revision; mark revoked and fence dependent work atomically. Does not retract already transmitted text. Source erasure is separate DELETE operation.'},
 {method:'post',path:'/context-preview',id:'previewContext',body:'ContextPreviewWrite',out:'ContextPreview',description:'Decrypt exact owned eligible fragments, validate Unicode code-point ranges, max3/1200 each/3000 total. Return keyed preview hashes. Read-only operation despite POST; no provider. 30/min/account.'},
 {method:'post',path:'/requests',id:'startReading',body:'StartRequest',out:'StartResponse',status:202,key:true,description:'Initial or follow-up intent. Admission before reservation. Atomic request/session/quota/QUEUED event; async wake. Duplicates join. 5/min,20 starts/day/account, 2 active/account; 3/day and30/month accepted model quota. 422 language/safety,403 consent,409 stale context,429 quota,503 backlog/spend.'},
 {method:'get',path:'/requests',id:'resolveIntent',out:'RequestStatus',query:['intentId'],description:'Resolve exact owned clientIntentId after reload; 404 if absent. No question text in query. Same polling/read rate.'},
 {method:'get',path:'/requests/{requestId}',id:'requestStatus',out:'RequestStatus',query:['after'],description:'Poll every2s initially, backoff to4s/10s; max60/min/request. Returns <=20 ordered content-free events plus authoritative state. If cursor aged out, state remains authoritative; fetch edition. 404 foreign/expired removed intent.'},
 {method:'post',path:'/requests/{requestId}/cancel',id:'cancelReading',body:'Empty',out:'RequestStatus',cas:true,key:true,description:'Atomic fence, quota release and STOPPED event. Published request returns409 with refresh semantics; cancellation never deletes an accepted edition. Remote abort best effort.'},
 {method:'get',path:'/sessions',id:'history',out:'HistoryPage',query:['cursor','limit','status'],description:'History saved by default; status=open resumes unsaved <=24h sessions. Keyset created_at DESC,id DESC, limit20 default/50 max. Cursor MAC binds owner/filter/page; no plaintext search.'},
 {method:'get',path:'/sessions/{sessionId}',id:'session',out:'SessionRecord',description:'Owned available session. Reopen references stored editions; no provider call. Open sessions expire24h unless saved.'},
 {method:'put',path:'/sessions/{sessionId}/save',id:'saveSession',body:'SaveWrite',out:'SessionRecord',cas:true,key:true,description:'Set saved/unsaved with CAS. Confirm only after commit; no automatic consent change. Unsave resets24h retention from explicit action. 30 mutations/min/account.'},
 {method:'get',path:'/readings/{editionId}',id:'reading',out:'Reading',description:'Exact immutable accepted/imported artifact plus current redaction projection. No regeneration. 410 CONTENT_UNAVAILABLE if withdrawn/deleted owned tombstone; 404 foreign.'},
 {method:'post',path:'/sessions/{sessionId}/reflections',id:'createReflection',body:'ReflectionWrite',out:'Reflection',status:201,key:true,description:'Insert authored revision1 and mark session saved in one guarded transaction; edition must belong to session/owner. No provider call. <=10k chars, max10 reflections/edition.'},
 {method:'get',path:'/reflections/{reflectionId}',id:'reflection',out:'Reflection',query:['revision'],description:'Current revision or exact prior revision. 410 if erased; no inference. All revisions available through export, <=100 revisions/reflection.'},
 {method:'put',path:'/reflections/{reflectionId}',id:'editReflection',body:'ReflectionWrite',out:'Reflection',cas:true,key:true,description:'CAS current revision; append immutable revision, update pointer, revoke old grants and fence dependent requests, mark session saved. 409 returns currentRevision; never overwrite local draft.'},
 {method:'delete',path:'/reflections/{reflectionId}/revisions/{revision}',body:'DeleteRequest',id:'eraseReflectionRevision',out:'DeletionReceipt',status:202,cas:true,key:true,description:'If-Match reflection current revision. Erase selected revision and downstream copies via ledger saga. Deleting current revision marks reflection deleted; cannot erase only text while leaving copied raw import/provenance.'},
 {method:'post',path:'/revisits',id:'addRevisit',body:'RevisitWrite',out:'Revisit',status:201,key:true,description:'Explicit authored note tied to exact owned edition; max2000 chars. No automatic tracking of reopening, no provider. Included in history/detail/export.'},
 {method:'get',path:'/revisits',id:'revisits',out:'RevisitPage',query:['cursor','limit','editionId'],description:'Keyset created_at DESC,id DESC, owned notes only, default20/max50. Response RevisitPage.'},
 {method:'post',path:'/exports',id:'createExport',body:'Empty',out:'ExportTicket',status:201,recent:true,key:true,description:'2/hour/account. Capture account.data_revision, sixty-minute ticket, no stored plaintext/file. Does not grant model permission.'},
 {method:'get',path:'/exports/{exportId}',id:'exportPage',out:'ExportPage',query:['cursor'],description:'<=100 portable records and <=1MiB/page. Cursor MAC binds owner,ticket,snapshot,table and last key. Any data revision change returns409 EXPORT_CHANGED and client discards partial file. No-store. Client writes NDJSON only after completion.'},
 {method:'post',path:'/imports',id:'previewImport',body:'ImportWrite',out:'ImportPreview',status:201,key:true,description:'10/day/account,2MiB HTTP cap,200k-character document cap,<=100 records. Parse exact allowlisted format offline; encrypt preview24h. Show duplicate/conflict/invalid items without any model egress.'},
 {method:'post',path:'/imports/{importId}/commit',id:'commitImport',body:'ImportCommit',out:'ImportResult',key:true,description:'Commit selected ready items in dependency order; atomic per session group, partial results explicit. Duplicate hash no-op; same original key with changed content conflicts. Imported facts/review remain unverified. Provider eligibility defaults absent.'},
 {method:'delete',path:'/sessions/{sessionId}',body:'DeleteRequest',id:'deleteSession',out:'DeletionReceipt',status:202,cas:true,key:true,description:'Client supplies receipt UUID and random256-bit token for lost-response recovery. Return202 only after independent receipt is durable. Immediate logical fence then erasure ledger saga for session and embedded copies. Preserves minimal broken references, never silently regenerates.'},
 {method:'delete',path:'/account',body:'DeleteRequest',id:'deleteAccount',out:'DeletionReceipt',status:202,recent:true,key:true,description:'Fence account, revoke auth and cancel work atomically. Receipt token provides status after logout. Completion requires durable erasure ledger and active-store/key removal.'},
 {method:'get',path:'/deletions/{receiptId}',id:'deletionStatus',out:'DeletionStatus',public:true,description:'Requires X-Deletion-Token scoped only to receipt; generic404 on invalid. 10/min/receipt. Coarse state only, no account identifiers/content.'},
];
const schemas:Record<string,unknown>={};
for(const[name,schema]of Object.entries(apiSchemas)){
 const doc=z.toJSONSchema(schema,{target:'draft-2020-12',unrepresentable:'throw'});
 delete doc.$schema;schemas[name]=doc;
}
const paths:Record<string,Record<string,unknown>>={};
const ref=(name:string)=>({$ref:'#/components/schemas/'+name});
for(const op of operations){
 const parameters:unknown[]=[];
 for(const [,name]of op.path.matchAll(/\{([^}]+)\}/g))parameters.push({name,in:'path',required:true,
   schema:name==='revision'?{type:'integer',minimum:1}:{type:'string',...(name==='credentialId'?{}:{format:'uuid'})}});
 for(const name of op.query??[])parameters.push({name,in:'query',required:name==='intentId',schema:
   ['limit','after','revision'].includes(name)?{type:'integer',minimum:name==='after'?0:1,...(name==='limit'?{maximum:50}:{})}:
   name==='status'?{type:'string',enum:['saved','open']}:{type:'string',...(name==='intentId'||name==='editionId'?{format:'uuid'}:{})}});
 if(op.cas)parameters.push({name:'If-Match',in:'header',required:true,schema:{type:'string',pattern:'^"[1-9][0-9]*"$'},description:'Quoted current integer revision. Missing428; stale409.'});
 if(op.key)parameters.push({name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:16,maxLength:128},description:'Same key+payload returns same committed logical result; changed payload409.'});
 if(op.method!=='get'&&!op.public)parameters.push({name:'X-CSRF-Token',in:'header',required:true,schema:{type:'string'}});
 if(op.id==='deletionStatus')parameters.push({name:'X-Deletion-Token',in:'header',required:true,schema:{type:'string'}});
 const status=op.status??200;const output=op.id==='revisits'?'RevisitPage':op.out;
 const responses:Record<string,unknown>={
  [status]:{description:status===204?'Committed; no response body.':'Successful result; private,no-store.',
   headers:{'Cache-Control':{schema:{type:'string',const:'private, no-store'}},'X-Correlation-ID':{schema:{type:'string',format:'uuid'}}},
   ...(output?{content:{'application/json':{schema:ref(output)}}}:{})},
 };
 for(const code of [400,401,403,404,409,410,413,422,428,429,500,503])responses[code]={description:
  ({400:'Invalid shape/range.',401:'Sign in again.',403:'Permission or recent authentication required.',404:'Absent or not owned.',409:'Refresh state; preserve local draft.',410:'Owned resource erased/withdrawn/expired.',413:'Payload exceeds budget.',422:'Unsupported language, safety boundary or invalid content.',428:'If-Match required.',429:'Quota or rate limit; honor Retry-After.',500:'Internal failure; use correlation ID.',503:'Dependency, key, spend or recovery unavailable.'} as Record<number,string>)[code],
  content:{'application/json':{schema:ref('ErrorEnvelope')}},headers:{'Retry-After':{schema:{type:'integer',minimum:1}}}};
 paths[op.path]??={};paths[op.path]![op.method]={operationId:op.id,summary:op.id,
  description:op.description+(op.recent?' Recent passkey authentication <=5 minutes.':''),
  security:op.public?[]:[{sessionCookie:[]}],parameters,responses,
  ...(op.body?{requestBody:{required:true,content:{'application/json':{schema:ref(op.body)}}}}:{}),
 };
}
const document={openapi:'3.1.0',info:{title:'Reflection API',version:'1.0.0',description:
 'PROPOSED SPECIFICATION. Same-origin only. Schema projection generated from DOMAIN_CONTRACTS.ts. Polling ProgressEvent carries no prose. All private responses no-store; foreign resources404. v1 public surface; no internal SQL/model/admin endpoints.'},
 servers:[{url:'/api/v1'}],security:[{sessionCookie:[]}],paths,components:{securitySchemes:{sessionCookie:{type:'apiKey',in:'cookie',name:'__Host-session'}},schemas}};
writeFileSync('docs/architecture/openapi.yaml','# Generated by checks/generate-openapi.ts from DOMAIN_CONTRACTS.ts; do not hand-edit schemas.\n'+YAML.stringify(document));
writeFileSync('docs/architecture/model-output.schema.json',JSON.stringify(z.toJSONSchema(ModelCandidate,{target:'draft-2020-12'}),null,2)+'\n');
console.log(`Generated ${operations.length} operations and ${Object.keys(schemas).length} schemas.`);
