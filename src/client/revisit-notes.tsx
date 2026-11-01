import {
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { z } from 'zod';
import { apiSchemas, type RevisitNote } from '../contracts/index.ts';
import { REVISIT_PRODUCT_COPY } from '../contracts/product-copy.ts';
import { REVISIT_LIMITS, revisitTextLength } from '../contracts/revisit-policy.ts';
import { api, ApiFailure } from './api.ts';
import { date } from './date.ts';
import { deletionIntent, DeletionReceiptPanel, type DeletionProof } from './deletion.tsx';
import { Notice, type NoticeMessage } from './notice.tsx';

type Page = z.infer<typeof apiSchemas.RevisitPage>;
function fullDate(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' });
}
const labels: Record<RevisitNote['stance'], string> = {
  unspecified: 'Not selected',
  resonates: 'Resonates',
  unsure: 'Unsure',
  disagree: 'Disagree',
};
function mergeNotes(previous: RevisitNote[], incoming: RevisitNote[]): RevisitNote[] {
  const merged = new Map(previous.map((note) => [note.id, note]));
  for (const note of incoming) {
    const prior = merged.get(note.id);
    if (!prior || prior.revision <= note.revision) merged.set(note.id, note);
  }
  return [...merged.values()].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
  );
}
export interface RevisitNotesHandle {
  hasUnsavedChanges(): boolean;
}

/** Private authored drafts live only in this mounted exact-edition workspace. */
export function RevisitNotes({
  ref,
  sessionId,
  editionId,
  saved,
  parentExpiresAt,
  csrfToken,
  onExpired,
  onChanged,
}: {
  ref?: Ref<RevisitNotesHandle>;
  sessionId: string;
  editionId: string;
  saved: boolean;
  parentExpiresAt: string | null;
  csrfToken: string;
  onExpired: () => void;
  onChanged: () => void;
}) {
  const [page, setPage] = useState<Page>({ items: [], nextCursor: null });
  const [loaded, setLoaded] = useState(false);
  const [editor, setEditorState] = useState<{ base: RevisitNote | null } | null>(null);
  const currentEditor = useRef<typeof editor>(editor);
  const setEditor = (next: typeof editor) => {
    // Outcomes need current ownership even between an editor action and its React commit.
    currentEditor.current = next;
    setEditorState(next);
  };
  const acceptedDeletions = useRef(new Set<string>());
  const [text, setText] = useState('');
  const [stance, setStance] = useState<RevisitNote['stance']>('unspecified');
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<RevisitNote | null>(null);
  const [expired, setExpired] = useState(false);
  const [reconciled, setReconciled] = useState(false);
  const [deleting, setDeleting] = useState<RevisitNote | null>(null);
  const [checked, setChecked] = useState(false);
  const [receipts, setReceipts] = useState<
    { proof: DeletionProof; initial: z.infer<typeof apiSchemas.DeletionStatus> | null }[]
  >([]);
  const retainReceipt = (receipt: (typeof receipts)[number]) => {
    setReceipts((prior) => {
      const existing = prior.find((item) => item.proof.receiptId === receipt.proof.receiptId);
      if (!existing) return [...prior, receipt];
      return prior.map((item) =>
        item === existing ? { ...item, initial: receipt.initial ?? item.initial } : item,
      );
    });
  };
  const [message, setMessage] = useState<NoticeMessage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deletionBusy, setDeletionBusy] = useState(false);
  const lifetime = useRef(0),
    operation = useRef(0),
    running = useRef(false),
    deletionOperation = useRef(0),
    deletionRunning = useRef(false),
    listVersion = useRef(0);
  const addRef = useRef<HTMLButtonElement>(null),
    textRef = useRef<HTMLTextAreaElement>(null),
    checkRef = useRef<HTMLInputElement>(null);
  const initiator = useRef<HTMLElement | null>(null);
  const deleteInitiator = useRef<HTMLElement | null>(null);
  const focusAfter = useRef<string | 'add' | 'origin' | null>(null);
  const deleteFocusAfter = useRef<string | null>(null);
  const headings = useRef(new Map<string, HTMLHeadingElement>());
  const edits = useRef(0);
  const intent = useRef<{ payload: string; key: string; at: number } | null>(null);
  const erase = useRef<{
    id: string;
    revision: number;
    at: number;
    value: ReturnType<typeof deletionIntent>;
  } | null>(null);
  const dirty = Boolean(
    editor &&
      (text !== (editor.base?.note ?? '') || stance !== (editor.base?.stance ?? 'unspecified')),
  );
  useImperativeHandle(ref, () => ({ hasUnsavedChanges: () => dirty || busy === 'save' }));
  const focusedEditor = useRef(editor);
  // Run after list/deletion commits as well as editor changes; focusAfter is consumed once.
  useLayoutEffect(() => {
    if (editor && focusedEditor.current !== editor) textRef.current?.focus();
    focusedEditor.current = editor;
    if (!editor && focusAfter.current) {
      const target = focusAfter.current;
      focusAfter.current = null;
      if (target === 'origin' && initiator.current?.isConnected) initiator.current.focus();
      else if (target !== 'add' && target !== 'origin' && headings.current.has(target))
        headings.current.get(target)?.focus();
      else addRef.current?.focus();
    }
    // Deletion's outcome must receive focus even while a different draft stays open.
    if (deleteFocusAfter.current) {
      const target = deleteFocusAfter.current;
      deleteFocusAfter.current = null;
      (headings.current.get(target) ?? addRef.current)?.focus();
    }
  });
  useLayoutEffect(() => {
    if (deleting) checkRef.current?.focus();
  }, [deleting]);
  const callbacks = useRef({ onExpired, onChanged });
  callbacks.current = { onExpired, onChanged };
  const run = useCallback(async (name: string, work: (current: () => boolean) => Promise<void>) => {
    // Editor replacement/cancellation owns only its channel; accepted deletions keep theirs.
    const deleting = name === 'delete';
    const active = deleting ? deletionRunning : running;
    const sequence = deleting ? deletionOperation : operation;
    if (active.current) return;
    active.current = true;
    const live = lifetime.current,
      version = ++sequence.current;
    const current = () => lifetime.current === live && sequence.current === version;
    if (deleting) setDeletionBusy(true);
    else setBusy(name);
    setMessage(null);
    try {
      await work(current);
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiFailure && error.status === 401) {
        callbacks.current.onExpired();
        return;
      }
      setMessage({
        tone: 'error',
        text: `${error instanceof Error ? error.message : 'This action could not be completed.'} ${name === 'list' ? 'Try loading notes again.' : 'Your draft is still here.'}`,
      });
    } finally {
      if (current()) {
        active.current = false;
        if (deleting) setDeletionBusy(false);
        else setBusy(null);
      }
    }
  }, []);
  const list = useCallback(
    async (current: () => boolean, cursor: string | null = null, all = false) => {
      const version = ++listVersion.current;
      let result: Page = { items: [], nextCursor: cursor };
      do {
        const next = await api(
          `/revisits?editionId=${encodeURIComponent(editionId)}${result.nextCursor ? `&cursor=${encodeURIComponent(result.nextCursor)}` : ''}`,
          apiSchemas.RevisitPage,
        );
        if (!current() || listVersion.current !== version) return;
        if (next.items.some((note) => note.sessionId !== sessionId || note.editionId !== editionId))
          throw new Error('The note list did not match this reading. Refresh to try again.');
        result = { items: [...result.items, ...next.items], nextCursor: next.nextCursor };
      } while (all && result.nextCursor);
      if (current() && listVersion.current === version) {
        setPage((prior) =>
          cursor && !all
            ? { items: mergeNotes(prior.items, result.items), nextCursor: result.nextCursor }
            : result,
        );
        setLoaded(true);
      }
    },
    [sessionId, editionId],
  );
  useEffect(() => {
    void run('list', (current) => list(current));
    return () => {
      lifetime.current++;
      operation.current++;
      deletionOperation.current++;
      listVersion.current++;
      running.current = false;
      deletionRunning.current = false;
      acceptedDeletions.current.clear();
      intent.current = null;
      erase.current = null;
    };
  }, [run, list]);
  const cancel = () => {
    operation.current++;
    running.current = false;
    setBusy(null);
    focusAfter.current = 'origin';
    setEditor(null);
    setText('');
    setStance('unspecified');
    setConflict(false);
    setLatest(null);
    intent.current = null;
    setExpired(false);
    setReconciled(false);
    setMessage(null);
  };
  const begin = (note: RevisitNote | null, trigger: HTMLElement) => {
    if (
      editor &&
      dirty &&
      !window.confirm('Discard your unsaved revisit note? Choose Cancel to stay and keep editing.')
    )
      return;
    operation.current++;
    running.current = false;
    setBusy(null);
    initiator.current = trigger;
    edits.current++;
    setEditor({ base: note });
    setText(note?.note ?? '');
    setStance(note?.stance ?? 'unspecified');
    setConflict(false);
    setLatest(null);
    intent.current = null;
    setExpired(false);
    setReconciled(false);
    setMessage(null);
  };
  const tooOld = (at: number) => Date.now() - at >= REVISIT_LIMITS.idempotencyMs;
  const save = () => {
    if (!editor || !saved || conflict) return;
    if (expired || (intent.current && tooOld(intent.current.at))) {
      setExpired(true);
      setMessage(null);
      return;
    }
    if (!text.trim() || revisitTextLength(text) > REVISIT_LIMITS.textCodePoints) {
      setMessage({
        tone: 'error',
        text: 'Write 1–2,000 characters, including at least one non-whitespace character.',
      });
      textRef.current?.focus();
      return;
    }
    const base = editor.base,
      input = { note: text, stance },
      edit = edits.current;
    const payload = JSON.stringify([base?.id, base?.revision, input]);
    if (intent.current?.payload !== payload)
      intent.current = { payload, key: crypto.randomUUID(), at: Date.now() };
    const attempt = intent.current;
    void run('save', async (current) => {
      setMessage({ tone: 'notice', text: 'Saving note…' });
      let result: RevisitNote;
      try {
        result = await api(
          base ? `/revisits/${base.id}` : '/revisits',
          apiSchemas.Revisit,
          base ? input : { editionId, ...input },
          csrfToken,
          {
            method: base ? 'PUT' : 'POST',
            key: attempt.key,
            ...(base ? { revision: base.revision } : {}),
          },
        );
      } catch (error) {
        if (!current()) return;
        if (error instanceof ApiFailure && error.status === 401) throw error;
        if (base && acceptedDeletions.current.has(base.id)) return;
        if (error instanceof ApiFailure && error.status === 409 && error.code === 'CONFLICT') {
          setConflict(true);
          setLatest(null);
          setMessage({
            tone: 'notice',
            text: 'The saved note changed. Your draft has been kept. Refresh the saved note to review it before saving again.',
          });
          return;
        }
        throw error;
      }
      if (!current() || acceptedDeletions.current.has(result.id)) return;
      // Acknowledgement owns identity/revision even if a later read fails offline.
      intent.current = null;
      listVersion.current++;
      setPage((prior) => ({ ...prior, items: mergeNotes(prior.items, [result]) }));
      callbacks.current.onChanged();
      if (edits.current === edit) {
        focusAfter.current = result.id;
        setEditor(null);
        setText('');
        setStance('unspecified');
        setConflict(false);
        setLatest(null);
        setMessage({ tone: 'success', text: 'Note saved.' });
      } else {
        setEditor({ base: result });
        setMessage({ tone: 'success', text: 'Note saved. Your newer draft is still here.' });
      }
      // The acknowledged submission is finished; its read must not block another intent.
      running.current = false;
      setBusy(null);
      try {
        // Replayed mutations may return a prior snapshot; refresh the list separately.
        await list(current, null, true);
      } catch (error) {
        if (!current()) return;
        if (error instanceof ApiFailure && error.status === 401) throw error;
        if (acceptedDeletions.current.has(result.id)) return;
        setMessage({
          tone: 'error',
          text: 'Note saved, but the note list could not be refreshed. Your draft is still here. Use Refresh notes to retry the read.',
        });
      }
    });
  };
  const refresh = () => {
    if (!editor?.base) return;
    void run('refresh', async (current) => {
      const note = await api(`/revisits/${editor.base!.id}`, apiSchemas.Revisit);
      if (current()) {
        setLatest(note);
        setMessage({
          tone: 'notice',
          text: 'Current saved note loaded separately. Your draft has been kept.',
        });
      }
    });
  };
  const reconcile = () =>
    void run('reconcile', async (current) => {
      await list(current, null, true);
      if (!current()) return;
      if (deleting) {
        deleteFocusAfter.current = deleting.id;
        setDeleting(null);
        setChecked(false);
        erase.current = null;
        setExpired(false);
        setReconciled(false);
        setMessage({
          tone: 'notice',
          text: 'Saved notes refreshed. Review the note and confirm deletion again.',
        });
        return;
      }
      setReconciled(true);
      if (editor?.base) {
        const note = await api(`/revisits/${editor.base.id}`, apiSchemas.Revisit);
        if (current()) {
          setLatest(note);
          setConflict(true);
        }
      }
      if (current())
        setMessage({
          tone: 'notice',
          text: 'Saved notes refreshed. Review them before choosing a new save intent.',
        });
    });
  const remove = () => {
    if (!deleting || !checked || deletionRunning.current) return;
    if (erase.current && tooOld(erase.current.at)) {
      setExpired(true);
      return;
    }
    if (
      !erase.current ||
      erase.current.id !== deleting.id ||
      erase.current.revision !== deleting.revision
    )
      erase.current = {
        id: deleting.id,
        revision: deleting.revision,
        at: Date.now(),
        value: deletionIntent(),
      };
    const attempt = erase.current,
      proof = { receiptId: attempt.value.receiptId, receiptToken: attempt.value.receiptToken };
    void run('delete', async (current) => {
      try {
        const result = await api(
          `/revisits/${attempt.id}`,
          apiSchemas.DeletionReceipt,
          proof,
          csrfToken,
          { method: 'DELETE', key: attempt.value.key, revision: attempt.revision },
        );
        if (!current()) return;
        acceptedDeletions.current.add(attempt.id);
        if (currentEditor.current?.base?.id === attempt.id) {
          setEditor(null);
          setText('');
          setStance('unspecified');
          setConflict(false);
          setLatest(null);
          intent.current = null;
          setExpired(false);
          setReconciled(false);
          running.current = false;
          setBusy(null);
        }
        retainReceipt({
          proof,
          initial: { state: result.state, backupExpiresBy: result.backupExpiresBy },
        });
        const index = page.items.findIndex((note) => note.id === attempt.id);
        deleteFocusAfter.current = page.items[index + 1]?.id ?? page.items[index - 1]?.id ?? 'add';
        listVersion.current++;
        setPage((prior) => ({
          ...prior,
          items: prior.items.filter((note) => note.id !== attempt.id),
        }));
        setDeleting(null);
        setChecked(false);
        erase.current = null;
        callbacks.current.onChanged();
        setMessage({
          tone: 'success',
          text: 'Note deletion accepted. All saved versions are included. Downloaded copies are unchanged.',
        });
      } catch (error) {
        if (!current()) return;
        if (error instanceof ApiFailure && error.status === 409 && error.code === 'CONFLICT') {
          erase.current = null;
          setDeleting(null);
          setChecked(false);
          await list(current, null, true);
          if (current()) {
            deleteFocusAfter.current = attempt.id;
            setMessage({
              tone: 'notice',
              text: 'The note changed. Review the saved note and confirm deletion again.',
            });
          }
        } else {
          retainReceipt({ proof, initial: null });
          throw error;
        }
      }
    });
  };
  const length = revisitTextLength(text);
  return (
    <section className="revisit-notes" aria-label="Revisit notes">
      <h2>Revisit notes</h2>
      <p>Your own dated thoughts, separate from the original reading and reflection.</p>
      <p id="revisit-disclosure">{REVISIT_PRODUCT_COPY.disclosure}</p>
      <Notice message={message} />
      {!saved && (
        <p className="notice">
          Save this reading explicitly before adding or editing a revisit note.
          {parentExpiresAt && (
            <>
              {' '}
              Temporary storage expires{' '}
              <time dateTime={parentExpiresAt}>{date(parentExpiresAt)}</time>.
            </>
          )}
        </p>
      )}
      {!loaded &&
        (busy === 'list' ? (
          <p role="status">Loading notes…</p>
        ) : (
          <button
            type="button"
            className="secondary"
            onClick={() => void run('list', (current) => list(current))}
          >
            Retry loading notes
          </button>
        ))}
      {loaded && page.items.length === 0 && <p>No revisit notes yet.</p>}
      <ol className="revisit-list">
        {page.items.map((note) => (
          <li key={note.id}>
            <article className="card revisit-note" aria-labelledby={`note-${note.id}`}>
              <h3
                id={`note-${note.id}`}
                tabIndex={-1}
                ref={(node) => {
                  if (node) headings.current.set(note.id, node);
                  else headings.current.delete(note.id);
                }}
              >
                Note ·{' '}
                <time dateTime={note.createdAt}>
                  <span aria-hidden="true">{date(note.createdAt)}</span>
                  <span className="sr-only">{fullDate(note.createdAt)}</span>
                </time>
              </h3>
              {note.updatedAt !== note.createdAt && (
                <p className="muted">
                  Edited{' '}
                  <time dateTime={note.updatedAt}>
                    <span aria-hidden="true">{date(note.updatedAt)}</span>
                    <span className="sr-only">{fullDate(note.updatedAt)}</span>
                  </time>
                </p>
              )}
              <p className="authored-note">{note.note || 'This saved legacy note is blank.'}</p>
              <p className="muted">Response: {labels[note.stance]}</p>
              <div className="actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={!saved}
                  onClick={(event) => begin(note, event.currentTarget)}
                >
                  Edit note
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={(event) => {
                    deleteInitiator.current = event.currentTarget;
                    setDeleting(note);
                    setChecked(false);
                  }}
                >
                  Delete note
                </button>
              </div>
            </article>
          </li>
        ))}
      </ol>
      {page.nextCursor && (
        <button
          type="button"
          className="secondary"
          disabled={busy === 'list'}
          onClick={() => void run('list', (current) => list(current, page.nextCursor))}
        >
          Load more notes
        </button>
      )}
      <button
        ref={addRef}
        type="button"
        disabled={
          !saved ||
          !loaded ||
          (page.items.length >= REVISIT_LIMITS.activePerEdition && !page.nextCursor)
        }
        onClick={(event) => begin(null, event.currentTarget)}
      >
        Add revisit note
      </button>
      {page.items.length >= REVISIT_LIMITS.activePerEdition && (
        <p>This reading has reached its 100-note limit. You can still read or delete notes.</p>
      )}
      {editor && (
        <form
          className="card revisit-editor"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <h3>{editor.base ? 'Edit revisit note' : 'Add revisit note'}</h3>
          <label htmlFor="revisit-text">Your revisit note</label>
          <textarea
            ref={textRef}
            id="revisit-text"
            name="note"
            rows={6}
            required
            aria-describedby="revisit-count revisit-disclosure revisit-draft"
            aria-invalid={length > REVISIT_LIMITS.textCodePoints || undefined}
            value={text}
            onChange={(event) => {
              edits.current++;
              setText(event.target.value);
            }}
          />
          <p id="revisit-count" className="muted">
            {length.toLocaleString()} / 2,000 characters
          </p>
          <label htmlFor="revisit-stance">Your response (optional)</label>
          <div className="select-field">
            <select
              id="revisit-stance"
              name="stance"
              value={stance}
              onChange={(event) => {
                edits.current++;
                setStance(event.target.value as RevisitNote['stance']);
              }}
            >
              {Object.entries(labels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <p id="revisit-draft" className="muted">
            Unsaved drafts stay only in memory and are lost when you leave this reading or reload.
          </p>
          <div className="actions">
            <button
              type="submit"
              disabled={
                busy === 'save' ||
                conflict ||
                expired ||
                !saved ||
                editor.base?.revision === REVISIT_LIMITS.revisionsPerNote
              }
            >
              Save note
            </button>
            <button type="button" className="secondary" onClick={cancel}>
              Cancel
            </button>
          </div>
          {editor.base?.revision === REVISIT_LIMITS.revisionsPerNote && (
            <p>
              This note has reached its 100 saved versions. You can still read, export or delete it.
            </p>
          )}
          {conflict && (
            <div className="notice revisit-conflict">
              <p>Your editable draft above has been kept.</p>
              <button
                type="button"
                className="secondary"
                disabled={busy === 'refresh'}
                onClick={refresh}
              >
                Refresh saved note
              </button>
              {latest && (
                <>
                  <p>Current saved note · revision {latest.revision}</p>
                  <blockquote>{latest.note || 'This saved legacy note is blank.'}</blockquote>
                  <p>Saved response: {labels[latest.stance]}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setEditor({ base: latest });
                      setConflict(false);
                      setLatest(null);
                      intent.current = null;
                      setExpired(false);
                      setReconciled(false);
                      setMessage({
                        tone: 'notice',
                        text: 'Your draft is ready for a deliberate save against this revision.',
                      });
                    }}
                  >
                    Use this revision for my next save
                  </button>
                </>
              )}
            </div>
          )}
        </form>
      )}
      {expired && (
        <div className="notice">
          <p role="status">
            Seven days have passed since this attempt. It will not be submitted again. Reconcile
            saved notes before choosing a new intent.
          </p>
          <button type="button" disabled={busy === 'reconcile'} onClick={reconcile}>
            Reconcile saved notes
          </button>
          {reconciled && !editor?.base && (
            <button
              type="button"
              onClick={() => {
                intent.current = null;
                erase.current = null;
                setExpired(false);
                setReconciled(false);
                setDeleting(null);
                setChecked(false);
              }}
            >
              Save as a new note
            </button>
          )}
        </div>
      )}
      {deleting && (
        <div className="notice delete-confirmation">
          <p>
            Delete the note saved{' '}
            <time dateTime={deleting.createdAt}>{date(deleting.createdAt)}</time> and all its saved
            versions? This removes active storage; backups are deleted on their own schedule.
            Downloaded copies are unchanged.
          </p>
          <label className="check">
            <input
              ref={checkRef}
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
            />
            Delete this note and all saved versions permanently
          </label>
          <div className="actions">
            <button
              type="button"
              className="danger"
              disabled={!checked || deletionBusy || expired}
              onClick={remove}
            >
              Confirm note deletion
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setDeleting(null);
                setChecked(false);
                deleteInitiator.current?.focus();
              }}
            >
              Cancel note deletion
            </button>
          </div>
        </div>
      )}
      {receipts.map((receipt, index) => (
        <section key={receipt.proof.receiptId} aria-label={`Note deletion receipt ${index + 1}`}>
          {receipts.length > 1 && <p>Note deletion receipt {index + 1}</p>}
          <DeletionReceiptPanel
            {...receipt}
            onDismiss={() =>
              setReceipts((prior) =>
                prior.filter((item) => item.proof.receiptId !== receipt.proof.receiptId),
              )
            }
          />
        </section>
      ))}
      {loaded && (
        <button
          type="button"
          className="text-button"
          disabled={busy === 'list'}
          onClick={() => void run('list', (current) => list(current, null, true))}
        >
          Refresh notes
        </button>
      )}
    </section>
  );
}
