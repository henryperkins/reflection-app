/** Synthetic contract/reference cases; no importer, history handler or export service is implemented. */
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {z} from 'zod';
import {ImportSource,ImportRecordIdentity,ImportRecovery,ImportPreview,LegacyRecord,ImportedReading,
  HistoryItem,SessionRecord,PortableRecord,apiSchemas} from '../src/contracts/index.ts';
type Source=z.infer<typeof ImportSource>;
type Identity=z.infer<typeof ImportRecordIdentity>;
type Recovery=z.infer<typeof ImportRecovery>;
const namespace='10101010-1010-4010-8010-101010101010',other='20202020-2020-4020-8020-202020202020';
const sessionId='30303030-3030-4030-8030-303030303030',editionId='40404040-4040-4040-8040-404040404040';
const stamp='2026-10-26T00:00:00Z',source:Source={namespaceId:namespace,revision:'original'};
const identity:Identity={source,kind:'reading',recordId:'upstream-7',recordRevision:1};
const mac=(value:unknown)=>createHmac('sha256',Buffer.alloc(32,5)).update(JSON.stringify(value)).digest('hex');
// Fixed arrays use the same canonical order as the specified JCS identity tuples.
function alias(id:Identity){return mac(['import-key.v1',id.source.namespaceId,id.source.revision,id.kind,id.recordId,id.recordRevision]);}
function entity(id:Identity){return mac(['import-entity.v1',id.source.namespaceId,id.kind,id.recordId,id.recordRevision]);}
type Row={identity:Identity;content:string;erased:boolean};
const rows=new Map<string,Row>();
const sameSource=(a:Source,b:Source)=>a.namespaceId===b.namespaceId&&a.revision===b.revision;
const erased=(id:Identity)=>[...rows.values()].some(r=>entity(r.identity)===entity(id)&&r.erased);
function classify(id:Identity,content:string,recovery:Recovery):'ready'|'duplicate'|'conflict'|'erased'{
  ImportRecordIdentity.parse(id);ImportRecovery.parse(recovery);
  if(recovery.kind!=='none'){
    const previous={...id,source:recovery.previousSource};
    if(recovery.kind==='new_revision'){
      assert.equal(id.source.namespaceId,previous.source.namespaceId);
      assert.notEqual(id.source.revision,previous.source.revision);
      const prior=rows.get(alias(previous));assert.ok(prior&&!prior.erased,'prior live identity required');
    }else{
      assert.notEqual(id.source.namespaceId,previous.source.namespaceId);
      assert.ok(erased(previous),'prior erased identity required');
    }
  }
  if(erased(id))return 'erased';
  const existing=rows.get(alias(id));
  return existing?(existing.content===content?'duplicate':'conflict'):'ready';
}
function preview(id:Identity,content:string,recovery:Recovery){
  const request=apiSchemas.ImportWrite.parse({format:'reflection-import.v1',source:id.source,recovery,document:content});
  const status=classify(id,content,recovery);
  return ImportPreview.parse({id:sessionId,expiresAt:stamp,source:request.source,recovery,
    previewHash:mac([request,id,status]),items:[{index:0,status,identity:id,originalId:id.recordId,error:null}]});
}
function commit(p:z.infer<typeof ImportPreview>,content:string,input:unknown){
  const parsed=apiSchemas.ImportCommit.parse(input);
  assert.equal(parsed.previewHash,p.previewHash);assert.deepEqual(parsed.confirmedRecovery,p.recovery);
  assert.deepEqual(parsed.indices,[0]);
  const id=p.items[0]?.identity;assert.ok(id);assert.ok(sameSource(id.source,p.source));
  const current=preview(id,content,p.recovery);assert.equal(current.previewHash,p.previewHash,'refresh stale preview');
  assert.ok(current.items[0]?.status==='ready'||current.items[0]?.status==='duplicate');
  if(current.items[0]?.status==='ready')rows.set(alias(id),{identity:id,content,erased:false});
}
const confirmation=(p:z.infer<typeof ImportPreview>)=>({indices:[0],previewHash:p.previewHash,confirmedRecovery:p.recovery});
const normal:Recovery={kind:'none'};
const first=preview(identity,'original bytes',normal);commit(first,'original bytes',confirmation(first));
assert.equal(preview(identity,'original bytes',normal).items[0]?.status,'duplicate');
assert.equal(preview(structuredClone(identity),'original bytes',normal).previewHash,
  preview(identity,'original bytes',normal).previewHash); // Rechunking preserves identity; no upload index in the key.
assert.equal(preview(identity,'changed bytes',normal).items[0]?.status,'conflict');
const revised={...identity,source:{...source,revision:'correction-1'}};
const revisionRecovery:Recovery={kind:'new_revision',previousSource:source};
const changed=preview(revised,'changed bytes',revisionRecovery);
assert.throws(()=>commit(changed,'changed bytes',{...confirmation(changed),confirmedRecovery:normal}));
commit(changed,'changed bytes',confirmation(changed));
assert.equal(rows.get(alias(identity))?.content,'original bytes');
assert.equal(rows.get(alias(revised))?.content,'changed bytes');
const secondDataset={...identity,source:{...source,namespaceId:other}};
assert.equal(preview(secondDataset,'colliding upstream ID',normal).items[0]?.status,'ready');
assert.notEqual(alias(secondDataset),alias(identity));
const beforeErasure=preview(identity,'original bytes',normal);
const original=rows.get(alias(identity));assert.ok(original);original.erased=true;original.content='';
assert.throws(()=>commit(beforeErasure,'original bytes',confirmation(beforeErasure)),/refresh stale preview/);
assert.equal(preview(identity,'original bytes',normal).items[0]?.status,'erased');
assert.equal(preview(revised,'changed bytes',normal).items[0]?.status,'erased'); // Source revision cannot evade erasure.
const reimport:Recovery={kind:'reimport_erased',previousSource:source};
const again=preview(secondDataset,'original bytes',reimport);
assert.throws(()=>commit(again,'original bytes',{...confirmation(again),confirmedRecovery:normal}));
commit(again,'original bytes',confirmation(again));
assert.equal(preview(secondDataset,'original bytes',reimport).items[0]?.status,'duplicate');
assert.equal(rows.get(alias(identity))?.erased,true);
assert.throws(()=>preview(identity,'original bytes',reimport)); // Re-import must allocate a different namespace.
assert.equal(apiSchemas.ImportWrite.safeParse({format:'tarot-json',document:'{}'}).success,false);
assert.equal(apiSchemas.ImportCommit.safeParse({indices:[0]}).success,false);

function questionPreview(question:string|null){
  if(question===null)return {questionPreview:null,questionTruncated:false};
  let prefix='';
  for(const point of question){if(prefix.length+point.length>500)break;prefix+=point;}
  return {questionPreview:prefix,questionTruncated:prefix.length!==question.length};
}
function roundTrip(question:string){
  const raw=JSON.stringify({id:identity.recordId,question});
  const record=LegacyRecord.parse({format:'reflection-import.v1',identity,parentIdentity:null,source:'tarot',
    originalId:identity.recordId,originalParentId:null,originalTimestamp:null,occurredAt:null,question,
    generatedText:'Original imported prose.',userStatements:[],basis:{method:'unknown',cards:[],sourceIds:[],
      rawBasisJson:null,verification:'legacy_unverified'},originalJsonText:raw,
    originalSha256:createHash('sha256').update(raw).digest('hex'),provenanceGaps:['timestamp','review'],review:'legacy_unknown'});
  const imported=ImportedReading.parse({kind:'legacy.imported.v1',editionId,sessionId,editionNumber:1,record,importedAt:stamp});
  const history=HistoryItem.parse({id:sessionId,revision:1,...questionPreview(record.question),createdAt:stamp,
    savedAt:stamp,latestEditionId:editionId,requestId:null,imported:true});
  const reopened=SessionRecord.parse({id:sessionId,revision:1,status:'saved',question:record.question,
    editionIds:[editionId],reflectionIds:[],savedAt:stamp,createdAt:stamp,requests:[]});
  const exported=PortableRecord.parse(JSON.parse(JSON.stringify({kind:'reading',identity,originalId:identity.recordId,value:imported})));
  assert.equal(exported.kind,'reading');
  if(exported.kind!=='reading'||exported.value.kind!=='legacy.imported.v1')throw new Error('wrong fixture');
  assert.equal(reopened.question,question);
  assert.equal(exported.value.record.question,question);
  assert.equal(exported.value.record.originalJsonText,raw);
  assert.deepEqual(exported.identity,identity);
  assert.deepEqual(exported.value.record.identity,identity);
  return history;
}
const long=roundTrip('q'.repeat(501));assert.equal(long.questionPreview?.length,500);assert.equal(long.questionTruncated,true);
const unicode=roundTrip('q'.repeat(499)+'😀tail');assert.equal(unicode.questionPreview,'q'.repeat(499));
assert.equal(unicode.questionTruncated,true);
assert.deepEqual(questionPreview(null),{questionPreview:null,questionTruncated:false});
assert.deepEqual(questionPreview('  original  '),{questionPreview:'  original  ',questionTruncated:false});
console.log('Import/history reference checks passed: duplicate, changed revision, colliding datasets, erased-alias/re-import confirmation, stable exported identity, and long/Unicode question preservation. No application handlers exercised.');
