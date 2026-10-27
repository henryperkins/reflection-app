import publicationGuard from './publication-guard.ts';

import { statement, DB_NOW, type Binding } from './core.ts';
export {
  statement,
  assertChanges,
  assertExists,
  DB_NOW,
  DAY,
  MONTH,
  type Binding,
} from './core.ts';

/** Named parameters are compiled only from our checked-in SQL, never caller SQL. */
export function currentGuard(
  db: D1Database,
  values: Record<string, Binding>,
  stage: 'start' | 'dispatch' | 'publish' | 'recover',
  developmentContent = false,
) {
  let source = publicationGuard;
  // Only the explicit local-live service admits draft content. Default guards stay unchanged.
  if (developmentContent)
    source = source.replace(
      "AND c.state IN('approved','superseded') AND c.rights_status='cleared'\n    AND c.reviewed_hash=c.hash AND c.reviewer_kind='human_approved'",
      "AND c.state='staged' AND c.rights_status!='disallowed' AND c.reviewer_kind='agent_reviewed'",
    );
  if (stage === 'recover')
    source = source.replace(
      "r.state IN('validating','fallback_pending')",
      "r.state IN('reserved','prepared','dispatching','received','validating','fallback_pending','uncertain')",
    );
  else if (stage !== 'publish')
    source = source.replace("r.state IN('validating','fallback_pending')", "r.state='prepared'");
  if (stage === 'start')
    source = source
      .replace('AND r.run_epoch=:run_epoch AND r.lease_token=:lease_token', '')
      .replace(`AND r.lease_expires_at>${DB_NOW}`, '')
      .replace(
        'AND sys.generation_enabled=1',
        "AND sys.dispatch_mode IN('model','outage_template') AND sys.generation_enabled=1",
      );
  if (stage === 'dispatch')
    source = source.replace(
      'AND sys.generation_enabled=1',
      "AND sys.dispatch_mode='model' AND sys.generation_enabled=1",
    );
  const bindings: Binding[] = [];
  source = source.replace(/:([a-z_]+)/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Missing guard binding: ${key}`);
    bindings.push(value);
    return '?';
  });
  return statement(db, source, ...bindings);
}
