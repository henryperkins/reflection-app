import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { apiSchemas, type AcceptedReading, type Reflection } from '../contracts/index.ts';
import { api, ApiFailure } from './api.ts';
import { signIn } from './passkeys.ts';

type View = z.infer<typeof apiSchemas.SessionView>;
type RecordView = z.infer<typeof apiSchemas.SessionRecord>;
type History = z.infer<typeof apiSchemas.HistoryPage>;
type Thought = z.infer<typeof Reflection>;
type Current = () => boolean;
const date = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function download(name: string, chunks: BlobPart[], type: string) {
  const url = URL.createObjectURL(new Blob(chunks, { type })),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Mounted only for a verified account. All private state and unfinished actions die on unmount. */
export function ReadingWorkspace({
  user,
  onSession,
  onExpired,
}: {
  user: View;
  onSession: (value: View) => void;
  onExpired: () => void;
}) {
  const [mode, setMode] = useState<'history' | 'new' | 'reading'>('history');
  const [history, setHistory] = useState<History>({ items: [], nextCursor: null });
  const [record, setRecord] = useState<RecordView | null>(null);
  const [reading, setReading] = useState<z.infer<typeof AcceptedReading> | null>(null);
  const [reflection, setReflection] = useState<Thought | null>(null);
  const [latestReflection, setLatestReflection] = useState<Thought | null>(null);
  const [draft, setDraft] = useState(''),
    [stance, setStance] = useState<Thought['stance']>('unspecified');
  const [question, setQuestion] = useState(''),
    [english, setEnglish] = useState(false),
    [reversals, setReversals] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false),
    [deleteChecked, setDeleteChecked] = useState(false);
  const alive = useRef(true),
    epoch = useRef(0),
    inFlight = useRef(false),
    currentUser = useRef(user),
    selected = useRef(record),
    currentMode = useRef(mode);
  currentUser.current = user;
  selected.current = record;
  currentMode.current = mode;
  const dirtyReflection =
    draft !== (reflection?.text ?? '') || stance !== (reflection?.stance ?? 'unspecified');
  const canLeave = () =>
    mode !== 'reading' ||
    !dirtyReflection ||
    window.confirm('Discard your unsaved reflection? Choose Cancel to stay and keep editing.');
  const clearReading = () => {
    setRecord(null);
    setReading(null);
    setReflection(null);
    setLatestReflection(null);
    setDraft('');
    setStance('unspecified');
    setConflict(false);
    setConfirmDelete(false);
    setDeleteChecked(false);
  };
  const intents = useRef(new Map<string, { payload: string; key: string; intent: string }>());
  const deletion = useRef<{
    id: string;
    revision: number;
    receiptId: string;
    receiptToken: string;
    key: string;
  } | null>(null);
  const actionKey = (action: string, payload: unknown) => {
    const text = JSON.stringify(payload),
      prior = intents.current.get(action);
    if (prior?.payload === text) return prior;
    const next = { payload: text, key: crypto.randomUUID(), intent: crypto.randomUUID() };
    intents.current.set(action, next);
    return next;
  };
  const refreshUser = async (current: Current) => {
    const view = await api('/me', apiSchemas.SessionView);
    if (current()) {
      currentUser.current = view;
      onSession(view);
    }
    return view;
  };
  const loadHistory = async (current: Current, cursor: string | null = null) => {
    const result = await api(
      `/sessions?status=saved${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      apiSchemas.HistoryPage,
    );
    if (current())
      setHistory((prior) =>
        cursor
          ? { items: [...prior.items, ...result.items], nextCursor: result.nextCursor }
          : result,
      );
  };
  const open = async (id: string, current: Current, keepDraft = false, requireReview = false) => {
    const session = await api(`/sessions/${id}`, apiSchemas.SessionRecord);
    if (!current()) return;
    const editionId = session.editionIds.at(-1);
    if (!editionId) throw new Error('No accepted reading is available yet.');
    const [content, note] = await Promise.all([
      api(`/readings/${editionId}`, apiSchemas.Reading),
      session.reflectionIds[0]
        ? api(`/reflections/${session.reflectionIds[0]}`, apiSchemas.Reflection)
        : Promise.resolve(null),
    ]);
    if (!current()) return;
    if (content.kind !== 'tarot.accepted.v1')
      throw new Error('This reading format is not available in the local build.');
    setRecord(session);
    setReading(content);
    setMode('reading');
    if (keepDraft && (dirtyReflection || conflict || requireReview)) {
      // Keep the draft's base revision until the user explicitly reconciles a newer version.
      if (note?.id !== reflection?.id || note?.revision !== reflection?.revision || requireReview) {
        setLatestReflection(note);
        setConflict(true);
        setMessage(
          'The saved reflection changed. Your draft has been kept. Review the current saved text and choose which version to use.',
        );
      }
    } else {
      setReflection(note);
      setLatestReflection(null);
      setDraft(note?.text ?? '');
      setStance(note?.stance ?? 'unspecified');
      setConflict(false);
    }
    setConfirmDelete(false);
    setDeleteChecked(false);
  };
  const run = async (action: (current: Current) => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const version = ++epoch.current;
    const current = () => alive.current && epoch.current === version;
    setBusy(true);
    setMessage('');
    try {
      await action(current);
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiFailure && error.status === 401) {
        onExpired();
        return;
      }
      setMessage(
        error instanceof Error
          ? error.message
          : 'This action could not be completed. Your draft is still here.',
      );
      if (error instanceof ApiFailure && error.status === 410) {
        clearReading();
        setMode('history');
        await loadHistory(current).catch(() => undefined);
      }
      if (error instanceof ApiFailure && error.code === 'CONSENT_REQUIRED')
        await refreshUser(current).catch(() => undefined);
    } finally {
      if (current()) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const runRef = useRef(run),
    openRef = useRef(open),
    historyRef = useRef(loadHistory);
  runRef.current = run;
  openRef.current = open;
  historyRef.current = loadHistory;
  useEffect(() => {
    alive.current = true;
    void runRef.current((current) => historyRef.current(current));
    const focus = () => {
      void runRef.current((current) =>
        currentMode.current === 'reading' && selected.current
          ? openRef.current(selected.current.id, current, true)
          : historyRef.current(current),
      );
    };
    window.addEventListener('focus', focus);
    return () => {
      alive.current = false;
      epoch.current++;
      intents.current.clear();
      deletion.current = null;
      window.removeEventListener('focus', focus);
    };
  }, []);
  const permission = () =>
    void run(async (current) => {
      const view = currentUser.current,
        allowed = !view.permission.modelAllowed;
      const payload = { modelAllowed: allowed, policyVersion: 'egress.v1' as const };
      await api('/permissions/model', apiSchemas.Permission, payload, view.csrfToken, {
        method: 'PUT',
        revision: view.permission.revision,
        key: actionKey('permission', [payload, view.permission.revision]).key,
      });
      if (current()) {
        intents.current.delete('permission');
        await refreshUser(current);
      }
    });
  const save = () => {
    if (record)
      void run(async (current) => {
        const next = await api(
          `/sessions/${record.id}/save`,
          apiSchemas.SessionRecord,
          { saved: true },
          currentUser.current.csrfToken,
          {
            method: 'PUT',
            revision: record.revision,
            key: actionKey('save', [record.id, record.revision]).key,
          },
        );
        if (current()) {
          setRecord(next);
          intents.current.delete('save');
          setMessage('Reading saved. Your reflection draft has not been submitted.');
        }
      });
  };
  const saveReflection = () => {
    if (record && reading && !conflict)
      void run(async (current) => {
        const body = { text: draft, stance, editionId: reading.editionId };
        try {
          const result = await api(
            reflection ? `/reflections/${reflection.id}` : `/sessions/${record.id}/reflections`,
            apiSchemas.Reflection,
            body,
            currentUser.current.csrfToken,
            {
              method: reflection ? 'PUT' : 'POST',
              ...(reflection ? { revision: reflection.revision } : {}),
              key: actionKey('reflection', [record.id, reflection?.revision, body]).key,
            },
          );
          if (!current()) return;
          const saved = await api(`/sessions/${record.id}`, apiSchemas.SessionRecord);
          if (current()) {
            setRecord(saved);
            setReflection(result);
            setLatestReflection(null);
            setDraft(result.text);
            setStance(result.stance);
            setConflict(false);
            intents.current.delete('reflection');
            setMessage('Reflection saved.');
          }
        } catch (error) {
          if (current() && error instanceof ApiFailure && error.status === 409) {
            await open(record.id, current, true, true);
          } else throw error;
        }
      });
  };
  const exportRecords = () =>
    void run(async (current) => {
      let view = currentUser.current;
      if (Date.parse(view.recentAuthUntil) <= Date.now()) {
        await signIn('reauthenticate', view.csrfToken);
        if (!current()) return;
        view = await refreshUser(current);
        if (!current()) return;
      }
      const ticket = await api('/exports', apiSchemas.ExportTicket, {}, view.csrfToken, {
        key: crypto.randomUUID(),
      });
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let cursor: string | null = null,
        bytes = 0;
      do {
        if (!current()) return;
        const page: z.infer<typeof apiSchemas.ExportPage> = await api(
          `/exports/${ticket.id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
          apiSchemas.ExportPage,
        );
        if (!current()) return;
        const chunk = new TextEncoder().encode(`${JSON.stringify(page)}\n`);
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024)
          throw new Error(
            'This export is too large for the local build. No partial file was downloaded.',
          );
        chunks.push(chunk);
        cursor = page.nextCursor;
      } while (cursor);
      if (current()) {
        download('reflection-export.ndjson', chunks, 'application/x-ndjson');
        setMessage(
          'Export downloaded. Keep it somewhere private; deleting records here cannot delete downloaded copies.',
        );
      }
    });
  const remove = () => {
    if (record)
      void run(async (current) => {
        if (!deletion.current || deletion.current.id !== record.id) {
          const bytes = crypto.getRandomValues(new Uint8Array(32));
          const token = btoa(String.fromCharCode(...bytes))
            .replaceAll('+', '-')
            .replaceAll('/', '_')
            .replaceAll('=', '');
          deletion.current = {
            id: record.id,
            revision: record.revision,
            receiptId: crypto.randomUUID(),
            receiptToken: token,
            key: crypto.randomUUID(),
          };
        }
        const request = deletion.current;
        let receipt: z.infer<typeof apiSchemas.DeletionReceipt>;
        try {
          receipt = await api(
            `/sessions/${request.id}`,
            apiSchemas.DeletionReceipt,
            { receiptId: request.receiptId, receiptToken: request.receiptToken },
            currentUser.current.csrfToken,
            { method: 'DELETE', revision: request.revision, key: request.key },
          );
        } catch (error) {
          if (current() && error instanceof ApiFailure && error.code === 'CONFLICT') {
            // A definite revision rejection did not commit this intent. Refresh and require a
            // new confirmation; ambiguous network failures keep the original receipt/key.
            deletion.current = null;
            await open(record.id, current, true);
            if (current())
              setMessage(
                'This reading changed. Review the updated reading and confirm deletion again.',
              );
            return;
          }
          throw error;
        }
        if (!current()) return;
        if (receipt.state !== 'complete') {
          setMessage('Deletion is still in progress. Keep this page open and retry to check it.');
          return;
        }
        clearReading();
        setMode('history');
        deletion.current = null;
        await loadHistory(current);
        if (current())
          setMessage('Reading and reflections deleted. Downloaded copies are unchanged.');
      });
  };
  return (
    <section className="reading-workspace" aria-label="Your readings" aria-busy={busy}>
      <div className="notice consent">
        <h2>AI readings are {user.permission.modelAllowed ? 'on' : 'off'}</h2>
        <p>
          AI permission is separate from saving. It allows your question to be used for a new
          reading. Saved readings and reflections are not sent automatically.
        </p>
        {!user.permission.modelAllowed && (
          <p>History, reopening, reflections, export and deletion remain available.</p>
        )}
        <button type="button" className="secondary" disabled={busy} onClick={permission}>
          {user.permission.modelAllowed ? 'Turn off AI readings' : 'Enable AI readings'}
        </button>
      </div>
      <nav className="actions" aria-label="Reading actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            if (!canLeave()) return;
            void run(async (current) => {
              await loadHistory(current);
              if (current()) {
                setMode('history');
                clearReading();
              }
            });
          }}
        >
          Saved readings
        </button>
        <button
          type="button"
          disabled={busy || !user.permission.modelAllowed}
          onClick={() => {
            if (!canLeave()) return;
            clearReading();
            setMode('new');
            setMessage('');
          }}
        >
          New reading
        </button>
        <button type="button" className="text-button" disabled={busy} onClick={exportRecords}>
          Export my records
        </button>
      </nav>
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {busy && <p role="status">Completing your reading action…</p>}
      {mode === 'history' && (
        <section aria-label="Saved reading history">
          <h2>Saved readings</h2>
          <p className="muted">
            Return to the original reading, cards and sources. Reopening uses no new generation or
            allowance.
          </p>
          {history.items.length === 0 ? (
            <p>No saved readings yet.</p>
          ) : (
            <ol className="reading-history">
              {history.items.map((item) => (
                <li key={item.id}>
                  <time dateTime={item.createdAt}>{date(item.createdAt)}</time>
                  <button
                    type="button"
                    className="history-link"
                    disabled={busy}
                    onClick={() => void run((current) => open(item.id, current))}
                  >
                    {item.questionPreview ?? 'Saved reading'}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {history.nextCursor && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void run((current) => loadHistory(current, history.nextCursor))}
            >
              Load more readings
            </button>
          )}
        </section>
      )}
      {mode === 'new' && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async (current) => {
              const view = currentUser.current;
              const values = {
                question: question.trim(),
                languageConfirmed: 'en' as const,
                reversals,
                permissionRevision: view.permission.revision,
                parentEditionId: null,
                selection: [],
              };
              const intent = actionKey('start', values);
              const started = await api(
                '/requests',
                apiSchemas.StartResponse,
                { ...values, clientIntentId: intent.intent },
                view.csrfToken,
                { key: intent.key },
              );
              let status = started.status;
              for (
                let attempt = 0;
                !['published', 'blocked', 'failed', 'expired', 'cancelled'].includes(
                  status.state,
                ) && attempt < 20;
                attempt++
              ) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                if (!current()) return;
                status = await api(`/requests/${started.requestId}`, apiSchemas.RequestStatus);
              }
              if (!current()) return;
              if (status.state !== 'published')
                throw new Error(
                  'This reading could not be completed. Your existing saved readings remain available.',
                );
              await open(started.sessionId, current);
              if (current()) {
                intents.current.delete('start');
                setQuestion('');
                await refreshUser(current);
              }
            });
          }}
        >
          <h2>A new reading</h2>
          <label htmlFor="reading-question">Your question</label>
          <textarea
            id="reading-question"
            rows={3}
            maxLength={500}
            required
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            disabled={busy}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={english}
              onChange={(event) => setEnglish(event.target.checked)}
              disabled={busy}
            />
            Use English for this reading
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={reversals}
              onChange={(event) => setReversals(event.target.checked)}
              disabled={busy}
            />
            Include reversed cards
          </label>
          <p className="storage-notice">
            Start temporarily stores your question and processing/recovery records for 24 hours from
            creation. Save reading keeps the result until you delete it.
          </p>
          <p className="muted">
            Drafts stay in memory until submitted. This build uses a local simulated writer. Use
            synthetic text only.
          </p>
          <button
            type="submit"
            disabled={busy || !english || !question.trim() || !user.permission.modelAllowed}
          >
            Start reading
          </button>
          <p className="muted">
            Local allowance: {user.remainingDay} today · {user.remainingMonth} this month.
          </p>
        </form>
      )}
      {mode === 'reading' && record && reading && (
        <section aria-label="Reading detail">
          <p className="eyebrow">Local simulated reading</p>
          <time dateTime={record.createdAt}>{date(record.createdAt)}</time>
          <article data-testid="accepted-reading" className="accepted-reading">
            <h2>{reading.question}</h2>
            {reading.units.map((unit) => (
              <section key={unit.position}>
                <h3>{unit.position}</h3>
                <p className="basis-text">{unit.basisText}</p>
                <p>{unit.interpretation}</p>
                <p>{unit.reflectionQuestion}</p>
              </section>
            ))}
            <p>{reading.closing}</p>
            <details>
              <summary>Cards and sources</summary>
              {reading.basis.cards.map((card, index) => (
                <div key={card.id} className="source">
                  <h3>
                    {card.position}: {card.cardId} · {card.orientation}
                  </h3>
                  <p>{reading.sources[index]!.text}</p>
                  <p>{reading.sources[index]!.rights.attribution}</p>
                  <p className="muted">
                    Source {reading.sources[index]!.id} · version {reading.sources[index]!.version}
                  </p>
                </div>
              ))}
              <p className="muted">
                Generated by the local simulation. Original accepted text and source snapshot are
                preserved.
              </p>
            </details>
          </article>
          <div className="save-reading">
            {record.status === 'saved' ? (
              <p className="saved-label">Saved until you delete it.</p>
            ) : (
              <>
                <p>
                  <strong>Not saved</strong> · Temporary storage lasts 24 hours from creation.
                </p>
                <button type="button" onClick={save} disabled={busy}>
                  Save reading
                </button>
                <p className="muted">
                  Save keeps this reading, its cards and sources until deletion. No reflection is
                  required.
                </p>
              </>
            )}
          </div>
          <section className="reflection-editor" aria-label="Personal reflection">
            <h2>{reflection ? 'Edit reflection' : 'Add reflection'}</h2>
            <p>
              This is your own writing. It does not change the reading or request AI generation.
            </p>
            {conflict && (
              <div className="notice">
                <p>
                  Current saved reflection
                  {latestReflection ? ` (revision ${latestReflection.revision})` : ''}:
                </p>
                <blockquote>{latestReflection?.text ?? 'No saved reflection.'}</blockquote>
                <p>Saved stance: {latestReflection?.stance ?? 'unspecified'}</p>
                <div className="actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setReflection(latestReflection);
                      setLatestReflection(null);
                      setConflict(false);
                      setMessage('Your draft is ready for the next save.');
                    }}
                  >
                    Keep my draft for the next save
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setReflection(latestReflection);
                      setDraft(latestReflection?.text ?? '');
                      setStance(latestReflection?.stance ?? 'unspecified');
                      setLatestReflection(null);
                      setConflict(false);
                      setMessage('The saved reflection is now in the editor.');
                    }}
                  >
                    Use the saved reflection
                  </button>
                </div>
              </div>
            )}
            <label htmlFor="reflection-text">Your reflection</label>
            <textarea
              id="reflection-text"
              rows={4}
              maxLength={10000}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={busy}
            />
            <label htmlFor="reflection-stance">How does this feel?</label>
            <select
              id="reflection-stance"
              value={stance}
              onChange={(event) => setStance(event.target.value as Thought['stance'])}
              disabled={busy}
            >
              <option value="unspecified">No stance selected</option>
              <option value="resonates">Resonates</option>
              <option value="unsure">Unsure</option>
              <option value="disagree">Disagree</option>
            </select>
            <p className="muted">
              Unsaved drafts stay only in memory and are lost when you leave this reading or reload.
            </p>
            {record.status !== 'saved' && (
              <p>Saving a reflection also saves this reading until deletion.</p>
            )}
            <button
              type="button"
              onClick={saveReflection}
              disabled={busy || conflict || !draft.trim()}
            >
              Save reflection
            </button>
          </section>
          <div className="deletion-actions">
            {!confirmDelete ? (
              <button
                type="button"
                className="text-button"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
              >
                Delete reading
              </button>
            ) : (
              <div className="notice">
                <p>
                  This deletes the reading and its reflections. Downloaded files cannot be removed.
                  Retained backups follow the separate erasure window.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={deleteChecked}
                    onChange={(event) => setDeleteChecked(event.target.checked)}
                    disabled={busy}
                  />
                  Delete this reading and its reflections permanently
                </label>
                <div className="actions">
                  <button type="button" onClick={remove} disabled={busy || !deleteChecked}>
                    Confirm deletion
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setConfirmDelete(false);
                      setDeleteChecked(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </section>
  );
}
