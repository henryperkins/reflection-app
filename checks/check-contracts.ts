import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {z} from 'zod';
import {TarotBasis,ModelCandidate,StartRequest,Reading,apiSchemas,Ciphertext,AstrologyInput} from '../docs/architecture/DOMAIN_CONTRACTS.ts';
const corpus=JSON.parse(readFileSync('docs/architecture/EVAL_CORPUS.json','utf8')) as {
  fixtures:{tarotBasis:unknown;candidate:unknown;start:unknown};cases:Array<{id:string;expected:{kind:string};rationale:string;assertions:string[]}>};
TarotBasis.parse(corpus.fixtures.tarotBasis);ModelCandidate.parse(corpus.fixtures.candidate);StartRequest.parse(corpus.fixtures.start);
assert.equal(ModelCandidate.safeParse({...corpus.fixtures.candidate as object,extra:'bad'}).success,false);
assert.equal(StartRequest.safeParse({...corpus.fixtures.start as object,languageConfirmed:'fr'}).success,false);
assert.equal(TarotBasis.safeParse({...corpus.fixtures.tarotBasis as object,kind:'astrology.natal.v1'}).success,false);
Reading.parse({kind:'reading.unavailable.v1',editionId:'10101010-1010-4010-8010-101010101010',
 sessionId:'20202020-2020-4020-8020-202020202020',editionNumber:1,parentEditionId:null,
 reason:'content_withdrawn',unavailableAt:'2026-10-26T00:00:00Z'});
AstrologyInput.parse({kind:'astrology.natal.v1',time:{certainty:'unknown',localDate:'2000-01-01',zone:'Europe/London'},
 latitudeDeg:51.5,longitudeEastDeg:-0.1,calendar:'gregorian',zodiac:'tropical',houses:'whole-sign'});
assert.equal(new Set(corpus.cases.map(c=>c.id)).size,corpus.cases.length);
for(const c of corpus.cases){assert.ok(c.rationale.length>10);assert.ok(c.assertions.length>0);}
for(const schema of Object.values(apiSchemas))z.toJSONSchema(schema,{target:'draft-2020-12',unrepresentable:'throw'});
// Disposable crypto property check, not the proposed application's crypto implementation.
const key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
const nonce=webcrypto.getRandomValues(new Uint8Array(12));
const aad=new TextEncoder().encode(JSON.stringify(['test','reading_sessions','question_enc','owner','record',1,1,1]));
const message=new TextEncoder().encode('SYNTHETIC_PRIVATE_MARKER');
const encrypted=await webcrypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:aad},key,message);
const envelope=Ciphertext.parse({v:1,alg:'A256GCM',keyVersion:1,aadRevision:1,
 nonce:Buffer.from(nonce).toString('base64url'),data:Buffer.from(encrypted).toString('base64url')});
assert.equal(envelope.aadRevision,1);
const opened=await webcrypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:aad},key,encrypted);
assert.equal(new TextDecoder().decode(opened),'SYNTHETIC_PRIVATE_MARKER');
await assert.rejects(()=>webcrypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:new TextEncoder().encode('other-owner')},key,encrypted));
await import('./check-recovery.ts');
await import('./check-imports.ts');
console.log(`Contract schemas and representative payloads passed; ${corpus.cases.length} corpus records well formed; AES-GCM AAD property passed. No semantic validator/provider exercised.`);
