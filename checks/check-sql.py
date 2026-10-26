"""Disposable artifact constraints/guard checks. Not Cloudflare runtime/app evidence."""
import sqlite3,json
from pathlib import Path
root=Path(__file__).resolve().parents[1]/'src/worker/db'
schema='\n'.join(p.read_text() for p in sorted((root/'migrations').glob('*.sql')));guard=(root/'publication_guard.sql').read_text()
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
 d.execute("UPDATE generation_requests SET lease_expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+60000, expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+180000")
 return d
params={'request_id':'request','owner_id':A,'key_version':1,'run_epoch':1,'lease_token':'lease','expected_state':'validating','plan_hmac':'plan','context_count':0}
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
 ('expired absolute request','update generation_requests set expires_at=999'),
 ('key rotation','update accounts set key_version=2'),
 ('account deletion',"update accounts set status='deleting'"),
 ('content withdrawn',"update content_editions set state='withdrawn'"),
 ('missing selected row','update generation_requests set context_count=1'),
]:
 d=seed();d.execute(sql);rejects(d,guard,params);checks.append(name)
# Worker sampled eligibility before the deadline; the unchanged SQL executes later.
# No sleep or alternate guard: both deadlines are in the actual database clock's past.
d=seed();execution_now=d.execute("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER)").fetchone()[0]
worker_now=execution_now-60000;deadline=execution_now-1000
assert worker_now<deadline<execution_now
d.execute('UPDATE generation_requests SET lease_expires_at=?, expires_at=?',(deadline,deadline))
rejects(d,guard,{**params,'now':worker_now}) # Extra legacy binding cannot authorize publication.
checks.append('stale worker timestamp cannot authorize expired publication')
# Freeze only the clock for the exact equality boundary; use the same guard SQL.
d=seed();d.create_function('unixepoch',1,lambda modifier:2000.0)
d.execute('UPDATE generation_requests SET lease_expires_at=2000000, expires_at=2000000')
rejects(d,guard,params);checks.append('deadline equality rejects publication')
d=seed();d.execute('UPDATE generation_requests SET lease_expires_at=2000000, expires_at=2000000')
d.execute('begin')
d.execute("insert into reading_editions values('late',?,'session',1,'request','basis',NULL,'accepted','model','cipher',1,?,0,NULL)",(A,H))
d.create_function('unixepoch',1,lambda modifier:2001.0)
try:
 d.execute(guard,params)
except sqlite3.IntegrityError:d.execute('rollback')
else:raise AssertionError('late publication guard must abort')
assert d.execute('select count(*) from reading_editions').fetchone()[0]==0
checks.append('execution-time expiry rolls back a preceding edition insert')
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
d=seed()
d.execute("INSERT INTO import_identities(owner_id,source_key_hmac,source_entity_hmac,original_hmac,session_id,entity_kind,source_record_enc,key_version) VALUES(?,'source-key','source-entity','original','session','session','private-original',1)",(A,))
rejects(d,"UPDATE import_identities SET erased_at=1000")
checks.append('erased import alias rejects retained private body or entity link')
d.execute("UPDATE import_identities SET erased_at=1000, source_record_enc=NULL, session_id=NULL")
d.execute("DELETE FROM reading_sessions WHERE id='session'")
assert d.execute("SELECT source_key_hmac,source_entity_hmac,erased_at FROM import_identities").fetchone()==('source-key','source-entity',1000)
assert not d.execute('pragma foreign_key_check').fetchall()
checks.append('detached erased alias survives source deletion')
rejects(d,"INSERT INTO import_identities(owner_id,source_key_hmac,source_entity_hmac,original_hmac,entity_kind,key_version,erased_at) VALUES(?,'source-key','source-entity','changed','session',1,1000)",(A,))
checks.append('erased source key still prevents duplicate alias insertion')
registry=json.loads((root/'column-registry.json').read_text())['tables'];d=new()
actual={r[0] for r in d.execute("select name from sqlite_master where type='table'")};assert actual==set(registry)
for t in actual:
 cols={r[1] for r in d.execute(f'pragma table_xinfo({t})')};assert cols==set(registry[t]['columns']),t
 assert all(c['class'] in ('P','M','E','S','K') for c in registry[t]['columns'].values())
assert not d.execute('pragma foreign_key_check').fetchall();checks.append('exact registry/table/column coverage')
print(json.dumps({'sqlite':sqlite3.sqlite_version,'tables':len(actual),'columns':sum(len(registry[t]['columns']) for t in actual),'checks':checks,'count':len(checks)},indent=2))
