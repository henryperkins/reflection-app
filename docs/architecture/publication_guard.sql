-- Run inside the publication D1 batch, immediately before the published-state
-- update. Earlier statements roll back on failure; a prior read is insufficient.
-- Deadline authority is the database execution clock, never a bound worker time.
-- Failure deliberately violates CHECK(ok=1), rolling back the whole batch.
INSERT INTO assertion_probe(ok)
SELECT 0
WHERE NOT EXISTS (
  SELECT 1 FROM generation_requests r
  JOIN accounts a ON a.id=r.owner_id
  JOIN account_keys k ON k.owner_id=a.id AND k.version=a.key_version
  JOIN reading_sessions s ON s.owner_id=r.owner_id AND s.id=r.session_id
  JOIN basis_snapshots b ON b.owner_id=r.owner_id AND b.id=r.basis_id AND b.session_id=r.session_id
  JOIN permission_revisions p ON p.owner_id=a.id AND p.revision=a.permission_revision
  JOIN content_editions c ON c.hash=r.content_hash
  JOIN system_state sys ON sys.id=1
  WHERE r.id=:request_id AND r.owner_id=:owner_id
    AND a.status='active' AND a.write_fence IS NULL
    AND a.recovery_ack_at IS NOT NULL
    AND a.key_version=:key_version AND r.key_version=:key_version
    AND a.permission_revision=r.permission_revision AND p.model_allowed=1
    AND s.status IN('open','saved') AND b.body_enc IS NOT NULL
    AND r.run_epoch=:run_epoch AND r.lease_token=:lease_token
    AND r.lease_expires_at>CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND r.expires_at>CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND r.state=:expected_state AND r.state IN('validating','fallback_pending')
    AND r.plan_hmac=:plan_hmac AND r.plan_enc IS NOT NULL
    AND r.context_count=:context_count
    AND (SELECT count(*) FROM generation_context xc WHERE xc.request_id=r.id)=r.context_count
    AND r.content_policy_revision=c.policy_revision
    AND c.state IN('approved','superseded') AND c.rights_status='cleared'
    AND c.reviewed_hash=c.hash AND c.reviewer_kind='human_approved'
    AND sys.generation_enabled=1 AND sys.provider_policy_hash=r.policy_hash
    AND (r.parent_edition_id IS NULL OR EXISTS (
      SELECT 1 FROM reading_editions parent
      WHERE parent.owner_id=r.owner_id AND parent.id=r.parent_edition_id
        AND parent.session_id=r.session_id AND parent.status='accepted' AND parent.mode!='legacy'
        AND EXISTS (SELECT 1 FROM content_editions pc WHERE pc.hash=parent.content_hash
          AND pc.state IN('approved','superseded') AND pc.rights_status='cleared')))
    AND NOT EXISTS (
      SELECT 1 FROM generation_context x
      LEFT JOIN context_grants g ON g.owner_id=x.owner_id AND g.id=x.grant_id
      LEFT JOIN reading_editions e ON e.owner_id=g.owner_id AND e.id=g.edition_id
      LEFT JOIN reflections f ON f.owner_id=g.owner_id AND f.id=g.reflection_id
      LEFT JOIN reflection_revisions v ON v.owner_id=g.owner_id AND v.reflection_id=g.reflection_id AND v.revision=g.reflection_revision
      WHERE x.request_id=r.id AND (
        g.id IS NULL OR g.state!='allowed' OR g.revision!=x.grant_revision OR x.fragment_enc IS NULL
        OR (g.edition_id IS NOT NULL AND (e.id IS NULL OR e.status NOT IN('accepted','imported') OR e.body_enc IS NULL
          OR (e.mode!='legacy' AND NOT EXISTS (SELECT 1 FROM content_editions ec
            WHERE ec.hash=e.content_hash AND ec.state IN('approved','superseded') AND ec.rights_status='cleared'))))
        OR (g.reflection_id IS NOT NULL AND (f.id IS NULL OR f.deleted_at IS NOT NULL
          OR f.current_revision!=g.reflection_revision OR v.body_enc IS NULL OR v.erased_at IS NOT NULL))
      )
    )
);
