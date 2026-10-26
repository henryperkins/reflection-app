# One-time authoring helper. Never run as a coverage gate: new columns need explicit review.
import sqlite3,json
from pathlib import Path
root=Path(__file__).resolve().parents[1]/'docs/architecture'
db=sqlite3.connect(':memory:');db.executescript((root/'schema.sql').read_text())
policies={
'assertion_probe':('empty','none','never contains a successful row'),
'content_editions':('public content until withdrawal policy','public source provenance','withdraw bytes when rights/safety policy requires; keep hash/status'),
'system_state':('current configuration','none','no personal data'),
'accounts':('account lifetime','profile metadata','delete after erasure ledger receipt'),
'account_keys':('account lifetime and rotation references','never','destroy after encrypted bodies removed; backup limits apply'),
'credentials':('until removed/account erased','metadata only','cascade account; revoke on recovery'),
'recovery_codes':('until used/rotated/account erased','never','delete on rotation/account erase'),
'auth_challenges':('5 minutes; purge within 1 hour','never','expiry or account cascade'),
'auth_sessions':('7 days absolute; 24h idle','never','logout/epoch change/account cascade'),
'permission_revisions':('account lifetime','permission history','account cascade'),
'reading_sessions':('saved lifetime; unsaved 24h; tombstone as referenced','session metadata and decrypted question','null body; retain broken reference shell'),
'basis_snapshots':('with session','decrypted typed basis','null body on session erase; cascade on account erase'),
'generation_requests':('published skeleton with edition; failures metadata30d/private24h','safe state and accepted provenance','null input/plan on target-copy erase; account cascade'),
'reading_editions':('saved lifetime; unsaved24h; unavailable shell as referenced','decrypted typed body and availability','null body on delete/required withdrawal; preserve reference shell'),
'reflections':('with session','metadata and revisions','mark deleted/null revision bodies; account cascade'),
'reflection_revisions':('saved lifetime unless explicitly erased','decrypted authored revision','null body and record erased_at; erase downstream copies'),
'context_grants':('with owner/source; revisions retained as snapshot','current grant and captured historical metadata','revoke on source correction/erase; account cascade'),
'generation_context':('with request/accepted provenance','decrypted exact selected fragment or redaction','null fragment on source-copy erase; account cascade'),
'generation_attempts':('30d then retain minimal epoch in accepted provenance','accepted provenance only','cascade when owner/request removed'),
'provider_dispatches':('accepted payload with saved edition; rejected candidate24h; failed metadata30d','accepted transmission and numeric usage, no raw rejected candidate','null payload/candidate/response ID on copy erase; account cascade'),
'quota_buckets':('current plus previous month; referenced periods retained','allowance/usage projection','account cascade; never delete referenced bucket'),
'quota_reservations':('with request','usage projection','account cascade after compensation'),
'quota_events':('with request; numeric history','usage projection','account cascade; no provider refund implied'),
'cost_adjustments':('90d or unresolved liability','owned usage projection before detachment','cascade cost row; no personal content'),
'spend_buckets':('90d or while unresolved liability','aggregate operational only','no owner linkage'),
'cost_reservations':('90d; unresolved financial totals may remain aggregate','owned numeric usage only','detach owner_id and dispatch_id before account erase'),
'request_events':('7 days','none; authoritative status still exported','purge by age/account cascade'),
'idempotency_keys':('7 days','never','expiry/account cascade'),
'revisits':('with owned saved edition','decrypted authored note','delete when target/session/account erased'),
'export_tickets':('60 minutes','never','expiry/account cascade; no export bodies stored'),
'import_batches':('preview24h; committed metadata30d','import origin projected from editions','expiry/owner cascade'),
'import_items':('preview raw24h; completed body purged after copy into edition','only committed original in edition','purge preview after24h; raw original in edition also erased'),
'import_identities':('with imported records; erased alias tombstone while account lives','original source records decrypted; no keyed indexes','set erased_at; null body and entity FKs before deletion; retain both identity HMACs to prevent silent reimport; account cascade'),
'deletion_jobs':('45 days after completed erasure; pending never purged','receipt status only','null target_enc on completion; remove identifiers at retention end'),
'security_operations':('D1 applied operation30d; R2 current checkpoint until superseded; old45d; pending indefinite','never','account deletion removes checkpoint after durable erasure; details in SECURITY_RESTORE'),
'rate_buckets':('48 hours','never','expiry; rotating HMAC prevents durable network tracking'),
}
result={'version':1,'classes':{'P':'public content/configuration','M':'sensitive operational metadata','E':'AES-GCM encrypted personal field','S':'secret verifier/hash; no plaintext export','K':'wrapped account key; KEK external'},'tables':{}}
for (table,) in db.execute("select name from sqlite_master where type='table' order by name"):
 retention,export,erase=policies[table];cols={}
 for _,name,typ,notnull,default,pk in db.execute(f'pragma table_info({table})'):
  cls='M'
  if table in ('assertion_probe','content_editions','system_state'):cls='P'
  if name.endswith('_enc'):cls='E'
  if table=='account_keys' and name in ('wrapped_key_enc','wrapped_index_key_enc'):cls='K'
  if name.endswith('_hash') and table in ('auth_sessions','auth_challenges','recovery_codes','accounts','idempotency_keys','deletion_jobs','rate_buckets'):cls='S'
  if name in ('token_hash','csrf_hash','code_hash','challenge_hash','browser_hash','receipt_token_hash','scope_hash','recovery_handle_hash'):cls='S'
  aad=None
  if cls=='E':
   record={'reflection_revisions':'reflection_id || : || revision','generation_context':'request_id || : || ordinal','import_items':'batch_id || : || item_index','import_identities':'source_key_hmac'}.get(table,'id')
   aad=f'[env,{table},{name},owner_id,{record},envelope.aadRevision,1,envelope.keyVersion]'
   if table=='deletion_jobs':aad="JCS([env,'erasure-target.v1',jobId,scope,subjectHmac,targetHmac,hmacKeyId,requestedAt,target.keyId]); same RecoveryCiphertext as R2 intent"
   if table=='security_operations':aad='[env,identity-checkpoint,HMAC(subjectId),epoch,id,1] under RECOVERY_KEK'
  if cls=='K':aad=f'[env,account-wrap,owner_id,version,wrap_key_id,{name}]'
  cols[name]={'aadRule':aad,'class':cls,'sqlType':typ,'nullable':not bool(notnull or pk),'default':default,'export':'never' if cls in ('S','K') else export}
 result['tables'][table]={'retention':retention,'erasure':erase,'columns':cols}
(root/'COLUMN_REGISTRY.json').write_text(json.dumps(result,indent=2)+'\n')
print('Recorded',len(result['tables']),'tables and',sum(len(x['columns']) for x in result['tables'].values()),'columns')
