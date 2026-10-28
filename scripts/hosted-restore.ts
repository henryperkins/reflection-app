import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  runHostedOperator,
  runHostedQualification,
  type VerifiedHostedTarget,
} from './hosted-qualify.ts';

export function runHostedRestore(
  target: VerifiedHostedTarget,
  scenario: 'stale-restore' | 'recovery-loss' | 'key-lifecycle',
) {
  return runHostedQualification(target, scenario);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(
      JSON.stringify(
        await runHostedOperator(process.argv.slice(2), [
          'stale-restore',
          'recovery-loss',
          'key-lifecycle',
        ]),
      ),
    );
  } catch {
    console.error(
      'Hosted restore drill stopped. Preserve keys, backups and the persistent offline fence; inspect protected executor state.',
    );
    process.exitCode = 1;
  }
}
