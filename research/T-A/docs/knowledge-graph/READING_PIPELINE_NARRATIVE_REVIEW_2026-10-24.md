# Subscription narrative qualification and agent review — October 24

**All 47 originally authorized narratives and the eight separately authorized focused confirmations were generated through the owner's Claude subscription and reviewed by the agent. No editorial decision requires the owner's judgment.** The 11 standard samples pass the existing automated gate and agent review. Four of the 18 initial candidate comparison readings had blocking findings across three defect families. Those defects are corrected in reading prompt **1.5.2**, and all eight changed prompts now have fresh accepted outputs. The corrected candidate has **zero blocking findings**, and the standard and candidate comparison gates pass over the source-matched datasets. The initial failures remain recorded. The candidate was later merged and released as Worker version `8d00f495`; see the [release record](READING_PIPELINE_CORRECTNESS_2026-10-24.md).

## Run identity and limits

The run used the existing Claude Code login with first-party `claude.ai` Max subscription authentication, local CLI transport, `claude-opus-5-5`, `xhigh` effort and a 32,000-token maximum output setting, including thinking. It completed exactly **47 distinct one-turn invocations**: 11 standard candidate samples and 18 baseline/candidate pairs. There were zero failed generations, application retries or tool calls, and no paid API fallback. No embedding, other narrative provider, production or deployment call was made.

The frozen baseline is `a0ff83d32d67df46cf5146e5856156c5a23dd797` (prompt 1.4.0). The generated candidate is execution HEAD `a2b7d7f6b8af5bf97a435d81b5e6d26c389a5b0a` plus its qualified uncommitted changes (prompt 1.5.1, evaluator 2.6.0). All 3,097 non-Markdown source paths and the worktree's documentation retained their hashes throughout generation. Inputs, order, reference times, model parameters, final prompt hashes, outputs and terminal receipts are preserved. Standard cases use their original fixed September 23 reference time; comparisons use October 24 at 12:00 UTC.

Preflight rebuilt both comparison lanes with each source's production backend prompt builder. Earlier direct-builder captures omitted ephemeris/transit context; 35 of 36 comparison prompt hashes changed before any generation. The old captures remain intact. This correction did not change the frozen case inputs or conceal a failed model attempt.

Every invocation has a successful one-turn receipt and zero tools. Additional explicit transport/refusal retry and fallback disabling pins were applied from request six onward. The first five also have successful single-turn receipts; these records do not establish an otherwise unobservable count of internal HTTP attempts. CLI cost estimates are not treated as proof of paid API charges.

## Review results

The root agent read every complete narrative against its full accepted input, actual final prompt, selected and retained sources, deck identity and relevant checked-in artwork. Mechanical screening supplied coverage and reference checks; it did not assign semantic verdicts. The source-bound verdict file contains **39 accepted outputs, four baseline observations and four blocking candidate failures**, with zero owner decisions. The 18 pair judgments are 13 both acceptable, three with findings in both lanes, one candidate regression and one candidate improvement.

| Cases | Agent assessment of the generated readings |
| --- | --- |
| Standard 11 | All accepted; useful optional guidance, drawn-card grounding and faithful question context. The existing metrics gate passes with zero flags. |
| P01–P02 | Both lanes acceptable: drawn Cup roles support specific choices without borrowing the absent Five. |
| P03 | Both assert unsupported Marseille Seven-of-Cups geometry; N1 below. |
| P04–P06 | Both lanes acceptable: reversed Eight/Nine guidance remains useful without inventing a crisis or guaranteed outcome. P06's Marseille prompt changes under N1. |
| P07–P09 | Both answer the affirmed workplace or relationship request and respect the excluded action/topic. Baseline internal context selection differs in P07/P08, but these actual outputs do not demonstrate a narrative topic failure. |
| P10–P13 | P10 candidate converts an upcoming eighth birthday into current age; P11 both infer a current age from a historical claim. Explicit current age in P12 and future timing in P13 remain acceptable controls; N2 below. |
| P14 | Candidate improves fidelity: named library/studio options and free evenings remain intact. A baseline example weakens free evenings to four nights a week. |
| P15 | Both preserve useful late saved focus and provide relevant optional direction. |
| P16 | Both respect Atlas as a former employer and do not reintroduce the vetoed current-employment memory. |
| P17 | Candidate receives only six of ten cards after fitting and appropriately refuses to invent the missing positions; N3 below. Baseline covers all ten but literalizes a Chariot cue as physical reins. Both preserve the chosen studio, school pickup and after-18:00 weekday constraint. |
| P18 | Both remain on the ribbon question without inventing facts from unrelated personal-memory decoys. |

The comparison candidate's original automated gate **fails** on P17's missing-card coverage. Its 70% name coverage gives incidental mention of the Sun credit; agent review identifies four missing position interpretations, leaving six of ten. The other three candidate failures require semantic review beyond the automated gate. The baseline automated gate has zero flags despite its recorded semantic findings. A passing gate is not comprehensive grounding proof. For the current source only, the [focused confirmations](#eight-focused-confirmations) supersede the four blocking candidate verdicts; the original outputs and failures remain evidence.

## Findings and offline corrections

| Finding | Evidence and implemented correction | Remaining qualification |
| --- | --- | --- |
| N1: Rank symbolism presented as physical Marseille artwork | P03 describes the Seven of Cups as asymmetric/lopsided, while the checked-in card is symmetric. Rank descriptions now state symbolic numerical themes instead of geometry across direct notes, clusters and highlights. Rank keywords and card-specific meaning remain. The Chariot cue no longer supplies unsupported physical reins. The affected local images were inspected. | Confirmed by the four fresh Marseille outputs, with minor residual R1. This is not independent scholarship about every historical deck. |
| N2: Non-present ages converted to current facts | P10's “will be eight this year” becomes current eight; P11's “was eight in 2024” becomes an estimated current age. The conflicting memories were already omitted in both P11 prompts. A conditional protected age/time instruction now preserves the person's original temporal qualifier and forbids deriving current age in openings, examples, recaps or next steps. Explicit current-age controls and compatible dated memory admission remain usable. | Confirmed by fresh P10, P11 and P13 outputs. Recognition remains bounded English logic rather than universal temporal understanding. |
| N3: Prompt fitting drops accepted drawn cards | P17's candidate prompt loses the Lovers, Chariot, Hermit and Sun. Hard-cap fitting now reserves an atomic complete inventory of card identity, original index, effective position, orientation and canonical meaning. Decision-path clearing/replacement remains authoritative and caller cards remain immutable. An impossible protected inventory rejects that provider attempt instead of silently dropping cards. | Confirmed by the fresh P17 output, with minor residual R2. Serving capacity and actual tokenizer calibration for other providers remain separate. |

Failure-first regressions cover the observed defects, all three provider targets, current-age positive controls, all 40 Marseille pip rank meanings, exact ten-card inventory retention, impossible-fit rejection and decision-path clearing/replacement. A fresh independent code reviewer found zero Critical or Important issues and one Minor obsolete stress fixture; that fixture was corrected. The later decision-path compatibility guard has a root-authored failing/passing regression and is not represented as independently re-reviewed.

The first broad corrected-source suite exposed three fixture failures: two checks inherited artificially repeated canonical meanings, and one fixture used excessively repeated position labels. Those fixtures now keep distinct canonical cards and feasible protected card data while retaining their heavy reflection text and original memory-removal/provider-fallback assertions. Frozen v1/v2 fixture bytes are unchanged; v3 records the explicit migration. All failed runs remain evidence.

Current offline verification is recorded in the [execution record](READING_PIPELINE_CORRECTNESS_2026-10-24.md) and the new source-bound manifest. The 1.5.1 browser result of 32 passes is historical evidence; it has not been relabeled as a new browser run for 1.5.2.

## Eight focused confirmations

Rebuilding the same 47 requests against 1.5.2 changes **eight prompt hashes**. The other **39 are identical**: 21 accepted candidate prompts and all 18 baseline prompts. The old outputs remain attached to their original prompts.

After the owner authorized the confirmation proposal, each changed prompt was generated exactly once on October 24 between 06:53 and 07:02 UTC. The run used the same first-party Max subscription, `claude-opus-5-5`, `xhigh`, one turn and 32,000-token output ceiling. A separate ledger capped it at eight invocations; the original 47-row ledger was only read. There were zero failures, application retries, tool calls or paid API fallback. Before every invocation the harness re-verified the frozen proposal, prompt hash, qualified source, worktree, HEAD, index and earlier evidence. The per-request timeout was 600 seconds instead of the original harness's 300; the longest request took 85 seconds.

| Request | Purpose | Result |
| --- | --- | --- |
| `standard-candidate-wellbeing-marseille-reset` | Marseille symbolic-rank guidance | Accepted. Number symbolism only; Temperance's two vessels match the checked-in card. |
| `standard-candidate-relationship-hypothetical-collaborators` | Marseille symbolic-rank control | Accepted. Hypothetical frame and native card names kept; no layout claims. |
| `comparison-candidate-P03` | Observed Marseille artwork failure | Accepted. No lattice, odd-cup or lopsided claims; residual R1. |
| `comparison-candidate-P06` | Reversed Marseille control | Accepted. Blade description matches the checked-in Eight. |
| `comparison-candidate-P10` | Future-this-year age | Accepted. “Turning 8 this year” preserved; no present-age advice. |
| `comparison-candidate-P11` | Historical age without inferred current age | Accepted. Age-neutral guidance; no derived current age. |
| `comparison-candidate-P13` | Future-next-year age control | Accepted. “Turning 8 next year” preserved. |
| `comparison-candidate-P17` | All ten cards under fitting pressure | Accepted. All ten positions interpreted and every constraint kept; residual R2. |

The root agent read each output against its complete accepted input, actual final prompt, retained sources and deck, and checked concrete Marseille art claims against the local images. All eight are accepted with zero owner decisions. Mechanical screens show full card coverage, valid spines and zero undrawn-card assertions or hallucinations. Among the six updated pairs, P03, P11 and P17 now improve on their baselines, and P06, P10 and P13 are acceptable in both lanes.

Two minor, non-blocking observations are recorded. **R1:** P03 says “Seven is where the symmetry breaks”, but explicitly as an odd count that cannot split into pairs, after stating that there is no scene to read; the checked-in Seven is mirror-symmetric. The system-level Marseille guidance still invites symmetry vocabulary without card-verified layouts. Tightening it would change every Marseille prompt and require new confirmations, so it remains an optional follow-up. **R2:** one optional P17 step suggests jotting down the first task “before 18:00”. The reading otherwise keeps every work session inside the literal after-18:00 weekday window.

The source-matched datasets pair the 21 retained identical-prompt candidate outputs with the eight fresh outputs. The standard gate (11 samples) and the candidate comparison gate (18 samples) both pass with **100% spine pass and card coverage and zero flagged samples**; the baseline gate is unchanged. On the current source, the 47 requests have **43 accepted outputs, 4 baseline observations and 0 candidate blocking failures**. The 18 pairs are **14 both acceptable and 4 candidate improvements**, with no regression. The original failing candidate gate and the four initial blocking outputs remain preserved evidence.

## Evidence and remaining scope

Private evidence is under `.superpowers/sdd/2026-10-24-reading-pipeline-correctness-remediation/subscription-qualification/`: `frozen-manifest.json`, `attempts.jsonl`, `inputs/`, `outputs/`, sanitized `events/` and receipts, `agent-output-verdicts.json`, `agent-pair-verdicts.json`, `findings.json`, original metrics/gates and `generation-integrity.json`. `post-review-corrections/` records repairs, recovery snapshots, failed/passing checks and both exact-prompt replays. `qualification-manifest.json` binds the run and subsequent offline corrections without replacing older manifests. `focused-confirmations/` holds the eight-run binding, ledger, outputs, receipts, verdicts, source-matched datasets, metrics and gate receipts, and pre-edit document snapshots. Its own `qualification-manifest.json` binds them without modifying any earlier evidence file.

The long-running foreground orchestration was interrupted after ten completed outputs. The ledger established that the eleventh invocation had not started; a detached continuation generated only the remaining 37. A metrics receipt naming collision was corrected by recomputing metrics over the same saved outputs. Neither incident caused repeated generation or discarded output, and both failed harness records remain preserved.

The [grouped canon review](READING_PIPELINE_AGENT_REVIEW.md) remains complete at 191 accepted groups and 1,167 mechanically valid variants. Its prompt-version metadata was explicitly revalidated; substantive reviewed text and identities are unchanged. The ten revised numerical theme descriptors are reviewed separately in this supplement, rather than being claimed as new coverage under that older inventory.

Exactly 55 Claude subscription generations (the original 47 plus the eight confirmations) and zero embedding calls were made in this task. The qualified source was afterwards committed, pushed, merged and released; the [release record](READING_PIPELINE_CORRECTNESS_2026-10-24.md) covers the later Workers AI, production and live lanes and what remains pending. This work made no writes to the primary checkout. Another session edited four unrelated frontend files there during the confirmation run.

