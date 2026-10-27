import { readFileSync, writeFileSync } from 'node:fs';
import { ContentBundleV2 } from '../src/contracts/index.ts';
import { contentHashV2, reviewedRecordHash } from '../src/domain/tarot/context-v2.ts';
import { meanings } from '../content/editorial/meanings-v2.ts';
import { wands } from '../content/editorial/wands-v2.ts';
import { cups } from '../content/editorial/cups-v2.ts';
import { swords } from '../content/editorial/swords-v2.ts';
import { pentacles } from '../content/editorial/pentacles-v2.ts';
const entries = { ...meanings, ...wands, ...cups, ...swords, ...pentacles };
const old = JSON.parse(readFileSync('content/launch-canon-draft.json', 'utf8'));
const bundle = ContentBundleV2.parse({
  ...old,
  schemaVersion: 2,
  createdAt: '2026-10-27T00:00:00Z',
  spreadVersion: 'situation-tension-possibility.v2',
  relationships: [],
  positionFrames: [
    {
      position: 'situation',
      text: 'Apply the selected idea to what the reader has actually described. Identify the relevant context, resource or way of understanding the question.',
    },
    {
      position: 'tension',
      text: 'Examine a distinction, trade-off, constraint or competing consideration. It may already be managed; this position does not require a problem.',
    },
    {
      position: 'possibility',
      text: 'Develop an available perspective, option or method. Explain how it could help the reader explore the question without predicting an outcome.',
    },
  ],
  fallbackV2: {
    synthesis:
      'Consider these perspectives alongside the purpose and conditions described in the question. An existing strength can remain the starting point; a different approach is worth considering only where it serves that purpose.',
    action:
      'One optional exercise is to compare the current approach with a small alternative using the same stated goal. Note what each would preserve, require and help clarify. The differences can inform whether any change is worthwhile.',
    question: null,
  },
  sources: old.sources.map((s: { cardId: string; orientation: string }) => {
    const entry = entries[s.cardId];
    if (!entry) throw new Error(`Missing editorial entry: ${s.cardId}`);
    const [upright, reversed, distinctions, positive, limit] = entry;
    const core = s.orientation === 'upright' ? upright : reversed;
    return {
      ...s,
      id: `reflection-v2-draft:${s.cardId}:${s.orientation}`,
      version: 1,
      text: core,
      fallbackText: positive,
      reflectionQuestion: 'What would make this perspective useful for the question you brought?',
      meaning: { core, distinctions, positive, limits: [limit], themes: [], imagery: null },
      rights: {
        status: 'unknown',
        evidence:
          'Original AI-assisted Reflection editorial draft; rights review pending. No artwork or copied Tarot passages included.',
        attribution: 'Reflection editorial draft (AI-assisted)',
        territory: 'Pending rights review',
      },
      review: {
        kind: 'agent_reviewed',
        reviewer: 'Codex draft; not human approval',
        reviewedHash: null,
        reviewedAt: null,
      },
    };
  }),
});
for (const source of bundle.sources) source.hash = await reviewedRecordHash(source);
bundle.editionHash = await contentHashV2(bundle);
const bytes = `${JSON.stringify(bundle, null, 2)}\n`;
const destination = 'content/reading-canon-v2-draft.json';
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== bytes) throw new Error('V2 draft is stale');
} else writeFileSync(destination, bytes);
console.log(
  JSON.stringify({
    contentHash: bundle.editionHash,
    sources: bundle.sources.length,
    humanApproved: false,
  }),
);
