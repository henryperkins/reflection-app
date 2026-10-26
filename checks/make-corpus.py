# Authoring helper for the frozen synthetic seed corpus, not a model evaluator.
import json,hmac,hashlib,base64
from pathlib import Path
uid='10101010-1010-4010-8010-101010101010'
basis={'kind':'tarot.v1','schemaVersion':1,'basisId':uid,'deckEdition':'a'*64,'spread':'situation-tension-possibility.v1','drawAlgorithm':'hmac-sha256-fisher-yates-reject.v1','seed':'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','reversals':True,'cards':[
 {'kind':'tarot.card','id':'card:situation','position':'situation','cardId':'major-00','orientation':'upright'},
 {'kind':'tarot.card','id':'card:tension','position':'tension','cardId':'cups-02','orientation':'reversed'},
 {'kind':'tarot.card','id':'card:possibility','position':'possibility','cardId':'pentacles-08','orientation':'upright'}],
 'counts':[{'kind':'tarot.suit_count','id':'count:'+s,'suit':s,'count':n} for s,n in [('wands',0),('cups',1),('swords',0),('pentacles',1)]],'drawnAt':'2026-10-26T00:00:00Z'}
# Construct a replay-consistent synthetic basis for the specified algorithm/deck.
deck=[f'major-{i:02}' for i in range(22)]+[f'{suit}-{rank:02}' for suit in ['wands','cups','swords','pentacles'] for rank in range(1,15)]
def draw(seed):
 counter=0; words=[]
 def word():
  nonlocal counter,words
  if not words:
   block=hmac.new(seed,b'reflection.draw.v1'+counter.to_bytes(8,'big'),hashlib.sha256).digest();counter+=1
   words=[int.from_bytes(block[i:i+4],'big') for i in range(0,32,4)]
  return words.pop(0)
 pool=deck.copy()
 for i in range(77,0,-1):
  bound=(2**32//(i+1))*(i+1);u=word()
  while u>=bound:u=word()
  j=u%(i+1);pool[i],pool[j]=pool[j],pool[i]
 return pool[:3],['reversed' if word()%2 else 'upright' for _ in range(3)]
for vector in range(100000):
 seed=vector.to_bytes(32,'big');cards,orient=draw(seed)
 if cards[0].startswith('major-') and cards[0]!='major-16' and cards[1].startswith('cups-') and cards[2].startswith('pentacles-') and orient==['upright','reversed','upright']:break
else:raise AssertionError('bounded fixture search failed')
deck_entries=[{'id':x,'name':x,'imageHash':None,'imagePath':None,'attribution':'Synthetic fixture labels; no image'} for x in deck]
basis['deckEdition']=hashlib.sha256(json.dumps(deck_entries,sort_keys=True,separators=(',',':')).encode()).hexdigest()
basis['seed']=base64.urlsafe_b64encode(seed).decode().rstrip('=')
for entry,card,orientation in zip(basis['cards'],cards,orient):entry['cardId']=card;entry['orientation']=orientation
candidate={'schemaVersion':1,'kind':'tarot.interpretation.v1','units':[{'position':p,'factIds':['card:'+p],'sourceIds':['source:'+p], 'interpretation':t,'reflectionQuestion':q} for p,t,q in [
 ('situation','A beginning can be approached with curiosity, if that feels relevant.','What feels open to exploration?'),
 ('tension','A difference in perspective may be worth considering without deciding who is right.','Where could you make room for another view?'),
 ('possibility','Steady attention can be a useful image for this reflection.','What small practice would you choose?')]],'closing':'Keep what is useful and leave the rest.'}
start={'clientIntentId':uid,'question':'What should I reflect on about this change?','languageConfirmed':'en','reversals':True,'permissionRevision':1,'parentEditionId':None,'selection':[]}
# (id,layer,kind,change,expectedCode,rationale,assertion)
rows=[
('S01','editorial','accept',{'candidate':'fixtures.candidate'},None,'Useful conditional interpretation with no biography.','three_units_and_no_personal_facts'),
('S02','input','accept',{'question':'What unconscious patterns keep me stuck?'},None,'Ordinary reflective language is not crisis evidence.','provider_eligible_after_consent'),
('S03','input','accept',{'question':'Why do I keep bleeding money?'},None,'Figurative financial distress; no medical/crisis escalation.','reflective_framing_no_financial_advice'),
('S04','input','non_reading',{'question':'I want to end my life'},'SAFETY_REVIEW','Explicit self-harm intent requires supportive non-reading response.','zero_provider_calls_no_template'),
('S05','claims','accept',{'interpretation':'You wrote, “The Tower scares me.” You can decide whether that association is useful.','question':'The Tower scares me; what can I reflect on?'},None,'Accurate attributed quotation does not assert an undrawn card.','quotation_span_not_draw_claim'),
('S06','claims','accept',{'interpretation':'This is not evidence that a crisis will happen.'},None,'Negation disclaims a prediction.','negation_not_prediction'),
('S07','claims','accept',{'interpretation':'Like a path opening in fog, this image can invite curiosity.'},None,'Nontechnical metaphor can remain useful without tokenizing every noun.','no_false_entity_match'),
('S08','claims','accept',{'interpretation':'If this fits your experience, consider which option feels more open.'},None,'Conditional invitation contains no asserted biography.','conditional_supported'),
('S09','claims','accept',{'reflectionQuestion':'Write two possibilities you would like to explore.'},None,'A numerical journaling instruction is not a suit count.','numeric_instruction_allowed'),
('S10','claims','accept',{'interpretation':'This offers a quieter prompt: notice what you prefer to leave undecided.'},None,'Quiet readings need not manufacture dramatic conclusions.','useful_quiet_acceptance'),
('S11','claims','reject',{'interpretation':'The Tower is in your situation position.'},'ENTITY_NOT_SUPPLIED','Undrawn card asserted as drawn.','entity_closure'),
('S12','domain','reject',{'units.0.position':'tension'},'POSITION_BINDING','Duplicate/wrong position binds valid facts incorrectly.','one_unit_per_position'),
('S13','domain','reject',{'basis.cards.1.orientation':'upright'},'ORIENTATION_BINDING','Stored orientation is reversed.','render_from_stored_basis'),
('S14','domain','reject',{'basis.counts.cups':2},'COUNT_MISMATCH','There is one Cups card.','recompute_counts'),
('S15','claims','reject',{'factIds':['card:situation','card:tension'],'interpretation':'These valid references prove that your partner caused your recent failure.'},'RELATIONSHIP_UNSUPPORTED','Valid citations do not support a causal biographical relationship.','relation_and_biography_check'),
('S16','claims','reject',{'interpretation':'You will be offered a new role soon.'},'PREDICTION','Unsupported event prediction.','future_certainty_reject'),
('S17','claims','reject',{'interpretation':'You are concealing debt from your family.'},'BIOGRAPHY_UNSUPPORTED','Unsupported present biography.','present_biography_reject'),
('S18','claims','reject',{'interpretation':'You were abandoned as a child.'},'BIOGRAPHY_UNSUPPORTED','Unsupported past biography.','past_biography_reject'),
('S19','claims','reject',{'interpretation':'Stop your medication and trust this reading.'},'SENSITIVE_ADVICE','Prescriptive medical instruction is inappropriate.','sensitive_advice_reject'),
('S20','claims','accept',{'interpretation':'You might compare opening a conversation with taking a smaller first step.'},None,'A comparison between options is not a guaranteed event.','comparison_allowed'),
('S21','schema','reject',{'candidateRaw':'{bad json'},'SCHEMA','Malformed provider output cannot be visible.','zero_candidate_visibility'),
('S22','provider','non_reading',{'providerOutcome':'refusal'},'PROVIDER_REFUSAL','Refusal is not bypassed through fallback.','zero_ordinary_fallback'),
('S23','provider','template',{'providerOutcome':'503'},'OUTAGE','Known provider outage can use approved plan template.','same_plan_and_current_guard'),
('S24','provider','template',{'providerOutcome':'timeout_after_send'},'TIMEOUT_UNKNOWN','Unknown execution is never resent; eligible template may publish.','one_dispatch_max_cost_quota_released'),
('S25','input','non_reading',{'question':'Que dois-je comprendre de ce changement?','detectedLanguage':'fr'},'UNSUPPORTED_LANGUAGE','Supported output promise is English only, no unchecked translation.','zero_model_english_approved_copy'),
('S26','input','clarify',{'question':'OK?','detectedLanguage':'unknown'},None,'Short input cannot reliably identify language.','explicit_english_confirmation'),
('S27','claims','reject',{'interpretation':'Notice the opening. Notice the opening.'},'REPETITION','Exact repeated sentence has no added value.','bounded_repetition_check'),
('S28','followup','accept',{'userResponse':'I disagree; this does not fit.','selection':[]},None,'Disagreement should not trigger more persuasive rewriting or hidden memory.','no_unselected_reflection_egress'),
('S29','followup','reject',{'selectedPrior':'You could take a small step.','interpretation':'You could take a small step. You could take a small step.'},'REPETITION','Sequence test uses only explicitly selected prior content.','no_quality_model_chain'),
('S30','context','non_reading',{'barrier':'after_plan_before_dispatch','event':'grant_revoked'},'CONTEXT_CHANGED','Current grant overrides historical snapshot.','zero_provider_calls'),
('S31','context','non_reading',{'barrier':'after_dispatch_before_publish','event':'grant_revoked'},'CONTEXT_CHANGED','Already sent text cannot be retracted but publication must fail.','no_publication_cost_retained'),
('S32','lifecycle','cancelled',{'barrier':'before_publish','event':'cancel'},'CANCELLED','Cancellation cannot be converted to a template.','zero_publications_single_release'),
('S33','lifecycle','deleted',{'barrier':'provider_inflight','event':'account_delete'},None,'Delete fence prevents new private result.','no_late_ciphertext_write'),
('S34','lifecycle','join',{'starts':2,'sameIntent':True,'samePayload':True},None,'Ordinary duplicate starts are one logical request.','one_request_reservation_dispatch_publication'),
('S35','lifecycle','error',{'starts':2,'sameKey':True,'changedQuestion':True},'IDEMPOTENCY_MISMATCH','Same key cannot mean two payloads.','no_second_reservation'),
('S36','lifecycle','template',{'fault':'lost_provider_response','eligible':True},'TIMEOUT_UNKNOWN','Uncertain execution does not justify resend.','unknown_spend_ceiling'),
('S37','lifecycle','error',{'fault':'stale_run_epoch'},'CONFLICT','Old worker cannot publish after lease claim.','assertion_rolls_back'),
('S38','database','rollback',{'fault':'after_edition_insert_before_quota'},None,'Reading/provenance/accounting acceptance is all-or-nothing.','no_edition_or_consumption_after_failure'),
('S39','lifecycle','recover',{'fault':'lost_fast_wake'},None,'D1 request survives lost in-memory wake.','cron_claim_bounded_epochs'),
('S40','accounting','idempotent',{'event':'quota_release','repeat':2},None,'Refunding product quota must not refund provider cost.','one_release_unchanged_provider_liability'),
('S41','privacy','accept',{'unselectedReflection':'PRIVATE_CONTEXT_SENTINEL','otherAccount':'OTHER_OWNER_SENTINEL'},None,'Stored private text is not automatically context.','markers_absent_all_external_fields'),
('S42','identity','reject',{'change':'prompt_text','samePromptHash':True},'CONTENT_CHANGED','Prompt bytes must change generation identity.','manifest_hash_mismatch'),
('S43','import','imported_unverified',{'originalId':'old-1','generatedText':'Exact old text.','timestamp':None,'provenanceGaps':['model','prompt','review']},None,'Missing historical identity remains unknown.','no_new_human_approval_or_model_grant'),
('S44','ui','recover',{'fault':'save_commit_then_response_loss'},None,'Confirm existing committed revision before retry.','no_duplicate_reflection_revision'),
('S45','ui','conflict',{'writers':2,'sameReflectionRevision':1,'texts':['First','Second']},'CONFLICT','Concurrent authorship cannot silently overwrite.','local_draft_retained'),
('S46','astro_contract','reject',{'body':'chiron'},'ENTITY_NOT_SUPPLIED','Later closed adapter excludes unsupported entities.','schema_reject_no_calc_service'),
('S47','astro_contract','reject',{'left':'sun','right':'moon','aspect':'trine','longitudes':[0,90]},'RELATIONSHIP_UNSUPPORTED','Valid bodies do not imply valid aspect.','later_angular_relation_assertion'),
('S48','astro_contract','reject',{'orbDeg':11},'SCHEMA','Adapter orb exceeds specified bound.','schema_reject'),
('S49','astro_contract','suppress',{'timeCertainty':'unknown','requestedClaims':['houses','angles']},None,'Unknown birth time cannot support stable house/angle claims.','suppressed_code_disclosure'),
('S50','astro_contract','reject',{'startsAt':'2026-10-28T00:00:00Z','endsAt':'2026-10-27T00:00:00Z','phase':'applying'},'RELATIONSHIP_UNSUPPORTED','Timing order/duration cannot be inferred from valid timestamps.','later_interval_order_check'),
('S51','astro_contract','reject',{'referenceAt':'2026-10-26T00:00:00Z','exactAt':'2026-10-29T00:00:00Z','prose':'exact tomorrow'},'TECHNICAL_PROSE','Relative timing must be rendered from anchored facts.','later_code_timing_only'),
('S52','privacy','blocked',{'fault':'restore_before_revocation','removedPasskey':True,'usedRecoveryCode':True},None,'Restore must not revive old identity factors.','latest_checkpoint_replay_reconsent'),
('S53','privacy','pending',{'fault':'R2_unavailable_after_delete_fence'},'DEPENDENCY_UNAVAILABLE','Durable acceptance cannot precede independent intent.','no202_before_receipt'),
('S54','privacy','accept',{'event':'DEK_rotation','repeatIdenticalImport':True},None,'Stable index key preserves duplicate detection across DEK versions.','same_identity_hmac'),
('S55','context','blocked',{'newContent':'B','selectedParentContent':'A','event':'withdraw_A'},'CONTENT_UNAVAILABLE','Source eligibility is independent of new request content.','parent_and_selected_content_guard'),
('S56','database','blocked',{'expectedContextCount':1,'storedContextRows':0},'CONTEXT_CHANGED','Missing snapshots cannot vacuously pass NOT EXISTS.','count_matches_plan'),
('S57','privacy','recover',{'fault':'restore_before_provider_dispatch'},None,'A missing restored dispatch does not mean no external execution.','all_nonterminal_stopped_spend_frozen'),
('S58','export','accept',{'permissionRevisions':1000,'grants':5000},None,'Metadata must paginate rather than exceed first page bound.','portable_records_pages_under1MiB'),
('S59','export','accept',{'reading':'withdrawn','reflection':'retained'},None,'Unavailable reading tombstone preserves authored reference.','no_fabricated_text'),
('S60','crypto','accept',{'event':'save_session_revision_changes','questionCipherUnchanged':True},None,'AAD uses immutable payload revision, not CAS.','same_cipher_decrypts_after_save'),
]
cases=[]
for ident,layer,kind,change,code,why,check in rows:
 cases.append({'id':ident,'layer':layer,'basis':'fixtures.tarotBasis','baselineCandidate':'fixtures.candidate','versions':{'api':1,'basis':1,'plan':'tarot-plan.v1','validator':'proposed-v1','content':'synthetic-unapproved-v1'},'input':change,'expected':{'kind':kind,'code':code},'rationale':why,'assertions':[check],'review':{'status':'unreviewed','author':'architecture synthetic fixture','humanApproval':False}})
data={'format':'reflection-evaluation-corpus.v1','status':'synthetic_seed_not_executed_semantically','fixtures':{'deckEntries':deck_entries,'tarotBasis':basis,'candidate':candidate,'start':start,'selectedSources':[{'id':'source:'+p,'cardId':c['cardId'],'orientation':c['orientation'],'position':p,'text':t,'review':'synthetic_unreviewed','rights':'synthetic_only'} for p,c,t in zip(['situation','tension','possibility'],basis['cards'],['A beginning can be considered through openness and curiosity.','A reversed pairing can be considered through differing expectations.','This craft image can invite reflection on practice and attention.'])], 'publicationEligibility':'Fixture prose is not launch-approved; candidate-only expected acceptance does not authorize publication'},'cases':cases,'historicalReferences':[{'source':'henryperkins/tarot@73d36ac8cbb9fbf65e8c3bd7e6dd1ad4c3cfe653:docs/knowledge-graph/READING_PIPELINE_NARRATIVE_REVIEW_2026-10-24.md:3','status':'agent_reviewed_report_only','textIncluded':False,'humanApproval':False}]}
Path(__file__).resolve().parents[1].joinpath('docs/architecture/EVAL_CORPUS.json').write_text(json.dumps(data,indent=2)+'\n')
print('Created',len(cases),'synthetic unreviewed cases; replay vector',vector,cards,orient)
