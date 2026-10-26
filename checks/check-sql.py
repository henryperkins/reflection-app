"""Disposable artifact constraints/guard checks. Not Cloudflare runtime/app evidence."""
import sqlite3,json
from pathlib import Path
root=Path(__file__).resolve().parents[1]/'docs/architecture'
schema=(root/'schema.sql').read_text();guard=(root/'publication_guard.sql').read_text()
A='10101010-1010-4010-8010-101010101010';B='20202020-2020-4020-8020-202020202020';H='a'*64;H2='b'*64;POL='c'*64
checks=[]
def new():
 d=sqlite3.connect(':memory:',isolation_level=None);d.executescript(schema);return d
def seed():
 d=new()
 for owner in (A,B):
  d.execute('insert into accounts(id,recovery_handle_hash,recovery_ack_at,created_at,updated_at) values(?,?,0,0,0)',(owner,owner))
  d.execute("insert into account_keys(owner_id,version,wrap_key_id,wrapped_key_enc,wrapped_index_key_enc,created_at) values(?,1,'test','cipher','index',0)",(owner,))
  d.execute("insert into permission_revisions values(?,1,1,'egress.v1',0)",(owner,))
 d.execute("insert into content_editions(hash,state,bundle_json,reviewed_hash,reviewer_kind,reviewer_id,rights_status,created_at,approved_at) values(?,'approved','{}',?,'human_approved','synthetic','cleared',0,0)",(H,H))
 d.execute('insert into system_state(id,active_content_hash,generation_enabled,provider_policy_hash,updated_at) values(1,?,1,?,0)',(H,POL))
 d.execute("insert into reading_sessions(id,owner_id,question_enc,created_at,retention_expires_at) values('session',?,'cipher',0,86400000)",(A,))
 d.execute("insert into basis_snapshots values('basis',?,'session','tarot.v1',1,'cipher',1,0)",(A,))
 d.execute("""insert into generation_requests(id,owner_id,session_id,client_intent_id,basis_id,operation,payload_hmac,state,run_epoch,lease_token,lease_expires_at,next_run_at,permission_revision,key_version,content_hash,content_policy_revision,policy_hash,input_enc,plan_enc,plan_hmac,created_at,expires_at)
 values('request',?,'session','intent','basis','initial','payload','validating',1,'lease',5000,0,1,1,?,1,?,'cipher','cipher','plan',0,99999)""",(A,H,POL))
 return d
params={'request_id':'request','owner_id':A,'key_version':1,'run_epoch':1,'lease_token':'lease','now':1000,'expected_state':'validating','plan_hmac':'plan','context_count':0}
def ok(name,f):f();checks.append(name)
def rejects(d,sql,args=()):
 try:d.execute(sql,args)
 except sqlite3.IntegrityError:return
 raise AssertionError('expected constraint failure')
d=seed();d.execute(guard,params);assert d.execute('select count(*) from assertion_probe').fetchone()[0]==0;checks.append('valid current publication guard')
for name,sql in [
 ('revoked permission','update accounts set permission_revision=2'),
 ('cancelled request',"update generation_requests set state='cancelled'"),
 ('stale run','update generation_requests set run_epoch=2'),
 ('expired lease','update generation_requests set lease_expires_at=999'),
 ('key rotation','update accounts set key_version=2'),
 ('account deletion',"update accounts set status='deleting'"),
 ('content withdrawn',"update content_editions set state='withdrawn'"),
 ('missing selected row','update generation_requests set context_count=1'),
]:
 d=seed();d.execute(sql);rejects(d,guard,params);checks.append(name)
d=seed();rejects(d,"insert into content_editions(hash,state,bundle_json,reviewed_hash,reviewer_kind,reviewer_id,rights_status,created_at,approved_at) values(?,'approved','{}',NULL,'human_approved','synthetic','cleared',0,0)",(H2,));checks.append('null reviewed hash rejected')
d=seed();rejects(d,"insert into basis_snapshots values('bad',?,'session','tarot.v1',1,'cipher',1,0)",(B,));checks.append('cross-owner basis FK rejected')
d=seed();rejects(d,"insert into generation_requests select 'other',owner_id,session_id,client_intent_id,parent_edition_id,basis_id,operation,payload_hmac,state,revision,run_epoch,lease_token,lease_expires_at,next_run_at,permission_revision,key_version,content_hash,content_policy_revision,policy_hash,input_enc,plan_enc,plan_hmac,context_count,next_event,error_code,fallback_reason,created_at,expires_at,finished_at from generation_requests");checks.append('duplicate intent rejected')
d=seed();d.execute('begin')
try:
 d.execute("insert into reading_editions values('edition',?,'session',1,'request','basis',NULL,'accepted','model','cipher',1,?,0,NULL)",(A,H))
 d.execute('insert into assertion_probe values(0)')
except sqlite3.IntegrityError:d.execute('rollback')
assert d.execute('select count(*) from reading_editions').fetchone()[0]==0;checks.append('failed statement rolls back preceding edition in SQLite transaction')
# Parent and selected source use content A while new request uses B: both must fail after A withdrawal.
for relation in ('parent','selected'):
 d=seed()
 d.execute("insert into reading_editions values('old',?,'session',1,'request','basis',NULL,'accepted','model','cipher',1,?,0,NULL)",(A,H))
 d.execute("insert into content_editions(hash,state,bundle_json,reviewed_hash,reviewer_kind,reviewer_id,rights_status,created_at,approved_at) values(?,'approved','{}',?,'human_approved','synthetic','cleared',0,0)",(H2,H2))
 d.execute('update generation_requests set content_hash=?',(H2,))
 if relation=='parent':d.execute("update generation_requests set operation='followup',parent_edition_id='old'")
 else:
  d.execute("insert into context_grants(id,owner_id,edition_id,state,created_at,updated_at) values('grant',?,'old','allowed',0,0)",(A,))
  d.execute("insert into generation_context values('request',?,0,'grant',1,'cipher','fragment',1)",(A,))
  d.execute('update generation_requests set context_count=1')
 p={**params,'context_count':1 if relation=='selected' else 0};d.execute(guard,p)
 d.execute("update content_editions set state='withdrawn' where hash=?",(H,));rejects(d,guard,p);checks.append(relation+' old-content withdrawal guarded')
 d.execute('delete from accounts where id=?',(A,));assert not d.execute('pragma foreign_key_check').fetchall();checks.append(relation+' populated account cascade')
d=seed();d.execute("insert into quota_buckets values(?,'day:2026-10-26',3,2,1)",(A,));rejects(d,'update quota_buckets set held=held+1');checks.append('quota bound enforced')
registry=json.loads((root/'COLUMN_REGISTRY.json').read_text())['tables'];d=new()
actual={r[0] for r in d.execute("select name from sqlite_master where type='table'")};assert actual==set(registry)
for t in actual:
 cols={r[1] for r in d.execute(f'pragma table_info({t})')};assert cols==set(registry[t]['columns']),t
 assert all(c['class'] in ('P','M','E','S','K') for c in registry[t]['columns'].values())
assert not d.execute('pragma foreign_key_check').fetchall();checks.append('exact registry/table/column coverage')
print(json.dumps({'sqlite':sqlite3.sqlite_version,'tables':len(actual),'columns':sum(len(registry[t]['columns']) for t in actual),'checks':checks,'count':len(checks)},indent=2))
