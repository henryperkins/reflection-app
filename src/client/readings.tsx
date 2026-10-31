import {
  type MouseEvent,
  type Ref,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { z } from 'zod';
import {
  apiSchemas,
  SpreadPhoto,
  type AnyAcceptedReading,
  type Reflection,
} from '../contracts/index.ts';
import { READING_PRODUCT_COPY, SPREAD_PHOTO_COPY } from '../contracts/product-copy.ts';
import { api, ApiFailure } from './api.ts';
import {
  RequestProgress,
  requestFromPath,
  requestPath,
  type ReadingRequest,
} from './request-progress.tsx';
import { deletionIntent, DeletionReceiptPanel, type DeletionProof } from './deletion.tsx';
import { date } from './date.ts';
import { Notice, type NoticeMessage } from './notice.tsx';
import { cardName } from './card-names.ts';
import { Art, historyArt } from './art.tsx';
import { Icon } from './icon.tsx';
import { CardFace, CardThumbnail } from './card-face.tsx';

type View = z.infer<typeof apiSchemas.SessionView>;
type RecordView = z.infer<typeof apiSchemas.SessionRecord>;
type History = z.infer<typeof apiSchemas.HistoryPage>;
type Thought = z.infer<typeof Reflection>;
type Current = () => boolean;
const stanceLabels: Record<Thought['stance'], string> = {
  unspecified: 'Not selected',
  resonates: 'Resonates',
  unsure: 'Unsure',
  disagree: 'Disagree',
};
function photoProcessingNotice(live: boolean | null, mode: string | null) {
  if (live === null)
    return 'Refresh to check the reading service and photo processing before submitting. Your draft stays in memory.';
  if (live) return SPREAD_PHOTO_COPY.spreadPhotoProcessing;
  return mode === 'hosted-synthetic'
    ? 'This preview does not recognize real cards. Use a synthetic image only.'
    : 'This simulation does not recognize real cards. Use a synthetic image only.';
}
function submissionNotice(live: boolean | null, mode: string | null) {
  if (live === null) return null;
  if (live)
    return 'Drafts stay in memory until submitted. Starting a reading sends this question to OpenAI.';
  return mode === 'hosted-synthetic'
    ? 'Drafts stay in memory until submitted. This preview simulates the reading and does not contact an AI provider. Use synthetic text only.'
    : 'Drafts stay in memory until submitted. This simulation does not contact an AI provider. Use synthetic text only.';
}
async function prepareSpreadPhoto(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    throw new Error('Choose a JPEG, PNG, or WebP photo of your spread.');
  if (file.size > 10 * 1024 * 1024)
    throw new Error('Spread photo is too large. Choose an image under 10 MB.');
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Could not read the selected image.'));
    reader.onerror = () => reject(new Error('Could not read the selected image.'));
    reader.readAsDataURL(file);
  });
  if (raw.length <= 150_000 && SpreadPhoto.safeParse(raw).success) return raw;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('Could not decode the selected image.'));
    element.src = raw;
  });
  const maxDimension = 960;
  const scale = Math.min(1, maxDimension / Math.max(img.width || 1, img.height || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((img.width || 1) * scale));
  canvas.height = Math.max(1, Math.round((img.height || 1) * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare the selected image.');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.8, 0.65, 0.5]) {
    const compressed = canvas.toDataURL('image/jpeg', quality);
    if (SpreadPhoto.safeParse(compressed).success) return compressed;
  }
  throw new Error('Spread photo is too large after compression. Try a smaller image.');
}
/** Only navigation and request identity survive an account-page visit, in memory. */
export interface WorkspaceResume {
  path: string;
  request: { target: ReadingRequest['target']; pending: boolean } | null;
}
export interface WorkspaceHandle {
  /** Asks before discarding unsaved writing; true when the workspace may close. */
  confirmLeave: () => boolean;
  getResumeState: () => WorkspaceResume;
}
/** Mounted only for a verified account. All private state and unfinished actions die on unmount. */
export function ReadingWorkspace({
  ref,
  resume,
  user,
  live = false,
  runtimeMode = null,
  onSession,
  onExpired,
  onAccount,
}: {
  ref?: Ref<WorkspaceHandle>;
  resume: WorkspaceResume | null;
  user: View;
  live?: boolean | null;
  runtimeMode?: string | null;
  onSession: (value: View) => void;
  onExpired: () => void;
  onAccount: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const [request, setRequest] = useState<ReadingRequest | null>(
    () =>
      requestFromPath() ??
      (resume?.request ? { target: resume.request.target, focus: false } : null),
  );
  const [requestPending, setRequestPending] = useState(
    () => Boolean(requestFromPath()) || Boolean(resume?.request?.pending),
  );
  const [navigationVersion, setNavigationVersion] = useState(0);
  const [mode, setMode] = useState<'history' | 'new' | 'reading' | 'request'>(() =>
    requestFromPath() ? 'request' : window.location.pathname === '/new' ? 'new' : 'history',
  );
  const shownPath = useRef(window.location.pathname);
  const resumeTarget = useRef(request?.target ?? null);
  const replacePath = (path: string) => {
    shownPath.current = path;
    window.history.replaceState(null, '', path);
  };
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const focusResultOnCommit = useRef(false);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const focusHistoryOnCommit = useRef(false);
  const [history, setHistory] = useState<History>({ items: [], nextCursor: null });
  useLayoutEffect(() => {
    if (mode === 'history' && focusHistoryOnCommit.current) {
      focusHistoryOnCommit.current = false;
      historyHeading.current?.focus();
    }
  }, [mode]);
  const [record, setRecord] = useState<RecordView | null>(null);
  const [reading, setReading] = useState<z.infer<typeof AnyAcceptedReading> | null>(null);
  useLayoutEffect(() => {
    if (mode === 'reading' && reading && focusResultOnCommit.current) {
      focusResultOnCommit.current = false;
      if (!document.hidden) resultHeading.current?.focus();
    }
  }, [mode, reading]);
  const [reflection, setReflection] = useState<Thought | null>(null);
  const [latestReflection, setLatestReflection] = useState<Thought | null>(null);
  const [revisionChoice, setRevisionChoice] = useState(1),
    [revisionNote, setRevisionNote] = useState<Thought | null>(null),
    [eraseRevisionChecked, setEraseRevisionChecked] = useState(false);
  const [revisionReceipt, setRevisionReceipt] = useState<{
    proof: DeletionProof;
    initial: z.infer<typeof apiSchemas.DeletionStatus> | null;
  } | null>(null);
  const revisionIntent = useRef<{
    payload: string;
    intent: ReturnType<typeof deletionIntent>;
  } | null>(null);
  const [draft, setDraft] = useState(''),
    [stance, setStance] = useState<Thought['stance']>('unspecified');
  const [question, setQuestion] = useState(''),
    [questionSubmitted, setQuestionSubmitted] = useState(false),
    [english, setEnglish] = useState(false),
    [reversals, setReversals] = useState(false),
    [spreadPhoto, setSpreadPhoto] = useState<string | null>(null),
    [spreadPhotoName, setSpreadPhotoName] = useState<string | null>(null),
    [photoAnnouncement, setPhotoAnnouncement] = useState(''),
    [preparingPhoto, setPreparingPhoto] = useState(false),
    spreadInputRef = useRef<HTMLInputElement>(null),
    choosePhotoRef = useRef<HTMLButtonElement>(null);
  const photoSelection = useRef(0),
    photoPreparing = useRef(false);
  const clearPhoto = () => {
    photoSelection.current++;
    photoPreparing.current = false;
    setPreparingPhoto(false);
    setSpreadPhoto(null);
    setSpreadPhotoName(null);
    setPhotoAnnouncement('Photo removed.');
    if (spreadInputRef.current) spreadInputRef.current.value = '';
  };
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState<NoticeMessage | null>(null),
    [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false),
    [deleteChecked, setDeleteChecked] = useState(false);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const deleteConfirmation = useRef<HTMLInputElement>(null);
  const restoreDeleteFocus = useRef(false);
  useLayoutEffect(() => {
    if (confirmDelete) deleteConfirmation.current?.focus();
    else if (restoreDeleteFocus.current) {
      restoreDeleteFocus.current = false;
      deleteTrigger.current?.focus();
    }
  }, [confirmDelete]);
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
  useImperativeHandle(ref, () => ({
    confirmLeave: () => {
      if (
        canLeave() &&
        (questionSubmitted ||
          (!question.trim() && !spreadPhoto && !photoPreparing.current) ||
          window.confirm(
            question.trim()
              ? 'Discard your unsaved question? Choose Cancel to stay and keep editing.'
              : 'Discard your unsaved spread photo? Choose Cancel to stay and keep editing.',
          ))
      )
        return true;
      // A cancelled browser Back/Forward must also restore history with a hidden question draft.
      if (window.location.pathname !== shownPath.current)
        window.history.pushState(null, '', shownPath.current);
      return false;
    },
    getResumeState: () => ({
      path: shownPath.current,
      request: request
        ? { target: resumeTarget.current ?? request.target, pending: requestPending }
        : null,
    }),
  }));
  const clearReading = () => {
    focusResultOnCommit.current = false;
    setRecord(null);
    setReading(null);
    setReflection(null);
    setLatestReflection(null);
    setDraft('');
    setStance('unspecified');
    setConflict(false);
    setConfirmDelete(false);
    setDeleteChecked(false);
    setRevisionNote(null);
    setRevisionReceipt(null);
    setEraseRevisionChecked(false);
    revisionIntent.current = null;
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
  const open = async (
    id: string,
    current: Current,
    keepDraft = false,
    requireReview = false,
    focusResult = false,
  ) => {
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
    if (content.kind !== 'tarot.accepted.v1' && content.kind !== 'tarot.accepted.v2')
      throw new Error('This reading format cannot be opened here.');
    setRecord(session);
    setReading(content);
    setMode('reading');
    replacePath(`/requests/${content.provenance.requestId}`);
    focusResultOnCommit.current = focusResult;
    if (keepDraft && (dirtyReflection || conflict || requireReview)) {
      // Keep the draft's base revision until the user explicitly reconciles a newer version.
      if (note?.id !== reflection?.id || note?.revision !== reflection?.revision || requireReview) {
        setLatestReflection(note);
        setConflict(true);
        setMessage({
          tone: 'notice',
          text: 'The saved reflection changed. Your draft has been kept. Review the current saved text and choose which version to use.',
        });
      }
    } else {
      setReflection(note);
      setLatestReflection(null);
      setDraft(note?.text ?? '');
      setStance(note?.stance ?? 'unspecified');
      setConflict(false);
    }
    if (note) setRevisionChoice(note.revision);
    else {
      setRevisionNote(null);
      setEraseRevisionChecked(false);
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
    setMessage(null);
    try {
      await action(current);
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiFailure && error.status === 401) {
        onExpired();
        return;
      }
      setMessage({
        tone: 'error',
        text:
          error instanceof Error
            ? error.message
            : 'This action could not be completed. Your draft is still here.',
      });
      if (error instanceof ApiFailure && error.status === 410) {
        clearReading();
        focusHistoryOnCommit.current = true;
        setMode('history');
        replacePath('/');
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
    historyRef = useRef(loadHistory),
    navigationRef = useRef(() => {});
  runRef.current = run;
  openRef.current = open;
  historyRef.current = loadHistory;
  navigationRef.current = () => {
    const path = window.location.pathname;
    // The parent closes this workspace for the account page; a restored address needs no change.
    if (path === '/account' || (mode !== 'request' && path === shownPath.current)) return;
    if (!canLeave()) {
      // Parent route state may already reflect Back; restore the reading still being edited.
      window.history.pushState(null, '', shownPath.current);
      return;
    }
    // Invalidate even an accepted-reading load that has outlived the progress response.
    epoch.current++;
    inFlight.current = false;
    setBusy(false);
    setMessage(null);
    clearReading();
    shownPath.current = path;
    const restored = requestFromPath();
    const destination = restored
      ? 'request'
      : window.location.pathname === '/new'
        ? 'new'
        : 'history';
    setRequest(restored);
    resumeTarget.current = restored?.target ?? null;
    setRequestPending(Boolean(restored));
    setNavigationVersion((value) => value + 1);
    setMode(destination);
    currentMode.current = destination;
    if (destination === 'new') {
      intents.current.delete('start');
      setQuestionSubmitted(false);
    }
    if (destination === 'history') void runRef.current((current) => historyRef.current(current));
  };
  useEffect(() => {
    alive.current = true;
    if (currentMode.current === 'history')
      void runRef.current((current) => historyRef.current(current));
    const focus = () => {
      if (currentMode.current === 'request') return;
      void runRef.current((current) =>
        currentMode.current === 'reading' && selected.current
          ? openRef.current(selected.current.id, current, true)
          : historyRef.current(current),
      );
    };
    const navigation = () => navigationRef.current();
    window.addEventListener('focus', focus);
    window.addEventListener('popstate', navigation);
    return () => {
      alive.current = false;
      photoSelection.current++;
      epoch.current++;
      intents.current.clear();
      deletion.current = null;
      window.removeEventListener('focus', focus);
      window.removeEventListener('popstate', navigation);
    };
  }, []);
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
          setMessage({
            tone: 'success',
            text: 'Reading saved. Your reflection draft has not been submitted.',
          });
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
            setMessage({ tone: 'success', text: 'Reflection saved.' });
          }
        } catch (error) {
          if (current() && error instanceof ApiFailure && error.status === 409) {
            await open(record.id, current, true, true);
          } else throw error;
        }
      });
  };
  const viewRevision = () => {
    if (reflection)
      void run(async (current) => {
        setRevisionNote(null);
        setEraseRevisionChecked(false);
        try {
          const value = await api(
            `/reflections/${reflection.id}?revision=${revisionChoice}`,
            apiSchemas.Reflection,
          );
          if (current()) setRevisionNote(value);
        } catch (error) {
          if (current() && error instanceof ApiFailure && error.status === 410)
            setMessage({ tone: 'notice', text: 'The selected revision has been erased.' });
          else throw error;
        }
      });
  };
  const eraseRevision = () => {
    if (!record || !reflection || !revisionNote) return;
    const currentRevision = revisionNote.revision === reflection.revision;
    if (currentRevision && !canLeave()) return;
    void run(async (current) => {
      const payload = JSON.stringify([reflection.id, revisionNote.revision, reflection.revision]);
      if (revisionIntent.current?.payload !== payload)
        revisionIntent.current = { payload, intent: deletionIntent() };
      const intent = revisionIntent.current.intent,
        proof = { receiptId: intent.receiptId, receiptToken: intent.receiptToken };
      try {
        const receipt = await api(
          `/reflections/${reflection.id}/revisions/${revisionNote.revision}`,
          apiSchemas.DeletionReceipt,
          proof,
          currentUser.current.csrfToken,
          { method: 'DELETE', revision: reflection.revision, key: intent.key },
        );
        if (!current()) return;
        setRevisionReceipt({
          proof,
          initial: { state: receipt.state, backupExpiresBy: receipt.backupExpiresBy },
        });
        if (receipt.state === 'complete') {
          await open(record.id, current, !currentRevision);
          if (current()) {
            setRevisionNote(null);
            setEraseRevisionChecked(false);
            revisionIntent.current = null;
            setMessage({ tone: 'success', text: 'Reflection revision erased.' });
          }
        }
      } catch (error) {
        if (current() && error instanceof ApiFailure && error.code === 'CONFLICT') {
          revisionIntent.current = null;
          setRevisionNote(null);
          setEraseRevisionChecked(false);
          await open(record.id, current, true);
          if (current())
            setMessage({
              tone: 'notice',
              text: 'The reflection changed. View the revision and confirm erasure again.',
            });
        } else {
          if (current()) setRevisionReceipt({ proof, initial: null });
          throw error;
        }
      }
    });
  };
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
              setMessage({
                tone: 'notice',
                text: 'This reading changed. Review the updated reading and confirm deletion again.',
              });
            return;
          }
          throw error;
        }
        if (!current()) return;
        if (receipt.state !== 'complete') {
          setMessage({
            tone: 'notice',
            text: 'Deletion is still in progress. Keep this page open and retry to check it.',
          });
          return;
        }
        clearReading();
        focusHistoryOnCommit.current = true;
        setMode('history');
        replacePath('/');
        deletion.current = null;
        await loadHistory(current);
        if (current())
          setMessage({
            tone: 'success',
            text: 'Reading and reflections deleted. Downloaded copies are unchanged.',
          });
      });
  };
  const photoNotice = photoProcessingNotice(live, runtimeMode);
  const submitNotice = submissionNotice(live, runtimeMode);
  const localRuntime = ['synthetic-only', 'synthetic-local', 'live-local'].includes(
    runtimeMode ?? '',
  );
  return (
    <section className="reading-workspace" aria-label="Your readings" aria-busy={busy}>
      {live === null && mode !== 'new' && (
        <p className="notice">
          <Icon name="info" />
          <span>Reading service status is unavailable. Saved readings remain available.</span>
        </p>
      )}
      {!user.permission.modelAllowed && (
        <p className="notice">
          <Icon name="info" />
          <span>
            AI readings are off. Saved readings and reflections remain available. To start a new
            reading,{' '}
            <a href="/account" onClick={onAccount}>
              turn on AI readings in your account
            </a>
            .
          </span>
        </p>
      )}
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
                replacePath('/');
                clearReading();
              }
            });
          }}
        >
          <Icon name="bookmark" />
          Saved readings
        </button>
        <button
          type="button"
          disabled={busy || !user.permission.modelAllowed || requestPending || live === null}
          onClick={() => {
            if (!canLeave()) return;
            // A deliberate new reading is a new intent, even if the question is unchanged.
            intents.current.delete('start');
            clearReading();
            setMode('new');
            setRequest(null);
            resumeTarget.current = null;
            setQuestionSubmitted(false);
            replacePath('/new');
            setMessage(null);
          }}
        >
          <Icon name="add" />
          New reading
        </button>
      </nav>
      <Notice message={message} />
      {busy && (
        <p role="status" className="busy-line">
          <span className="spinner" aria-hidden="true" />
          Completing your reading action…
        </p>
      )}
      {mode === 'history' && (
        <section className="history-section" aria-label="Saved reading history">
          <h2 ref={historyHeading} tabIndex={-1} className="title-section">
            Saved readings
          </h2>
          <p className="muted">
            Return to the original reading, cards and sources. Opening one does not start a new
            reading.
          </p>
          {history.items.length === 0 ? (
            <div className="empty-history">
              <Art name="study-possibility" className="empty-history-art" />
              <p>No saved readings yet.</p>
            </div>
          ) : (
            <ol className="reading-history">
              {history.items.map((item) => (
                <li key={item.id}>
                  <Art name={historyArt(item.id)} className="history-art" loading="lazy" />
                  <div className="history-copy">
                    <time dateTime={item.createdAt}>{date(item.createdAt)}</time>
                    <button
                      type="button"
                      className="history-link"
                      disabled={busy}
                      onClick={() =>
                        void run((current) => open(item.id, current, false, false, true))
                      }
                    >
                      <span>{item.questionPreview ?? 'Saved reading'}</span>
                      <Icon name="chevron" />
                    </button>
                  </div>
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
      {mode === 'history' && request && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            const target = resumeTarget.current ?? request.target;
            setRequest({ target, focus: false });
            replacePath(requestPath(target));
            setMode('request');
          }}
        >
          Resume reading request
        </button>
      )}
      {mode === 'request' && request && (
        <RequestProgress
          key={`${request.target.id}:${navigationVersion}`}
          request={request}
          user={user}
          onSession={onSession}
          onExpired={onExpired}
          onTarget={(target) => {
            resumeTarget.current = target;
            replacePath(requestPath(target));
          }}
          onAllowNew={() => setRequestPending(false)}
          onAccepted={(id, focus) =>
            void run(async (current) => {
              await open(id, current, false, false, focus);
              if (current()) {
                intents.current.delete('start');
                setQuestion('');
                clearPhoto();
                setQuestionSubmitted(false);
                await refreshUser(current);
              }
            })
          }
        />
      )}
      {mode === 'new' && (
        <form
          className="card new-reading"
          onSubmit={(event) => {
            event.preventDefault();
            if (inFlight.current || requestPending || photoPreparing.current) return;
            const values = {
              question,
              languageConfirmed: 'en' as const,
              reversals,
              permissionRevision: currentUser.current.permission.revision,
              parentEditionId: null,
              selection: [],
              ...(spreadPhoto ? { spreadPhoto } : {}),
            };
            const intent = actionKey('start', values);
            const target = { kind: 'intent' as const, id: intent.intent };
            resumeTarget.current = target;
            replacePath(requestPath(target));
            setRequest({
              target,
              start: { input: { ...values, clientIntentId: intent.intent }, key: intent.key },
              focus: true,
            });
            setRequestPending(true);
            setQuestionSubmitted(true);
            setMode('request');
            setMessage(null);
          }}
        >
          <div className="new-reading-heading">
            <h2 className="title-section">A new reading</h2>
            <Art name="spread-ribbon" mobileName="mobile-corner" className="new-reading-art" />
          </div>
          <div className="new-reading-layout">
            <div className="new-reading-content">
              <label htmlFor="reading-question">Your question</label>
              <p id="reading-question-help">
                Include what you are considering, what already works, and anything you want the
                reading to take into account.
              </p>
              <textarea
                id="reading-question"
                aria-describedby="reading-question-help"
                rows={3}
                maxLength={500}
                required
                value={question}
                onChange={(event) => {
                  setQuestion(event.target.value);
                  setQuestionSubmitted(false);
                }}
                disabled={busy}
              />
              <div className="spread-upload-field">
                <label htmlFor="reading-spread-photo">Photo of your spread (optional)</label>
                <p id="reading-spread-photo-help" className="muted">
                  Situation, tension, possibility — from left to right. Use a photo of three cards
                  you have already drawn to recognize your cards and orientations instead of drawing
                  new ones.
                </p>
                <input
                  ref={spreadInputRef}
                  id="reading-spread-photo"
                  aria-describedby="reading-spread-photo-help reading-photo-processing"
                  className="photo-file-input"
                  tabIndex={-1}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    const selection = ++photoSelection.current;
                    photoPreparing.current = true;
                    setPreparingPhoto(true);
                    setPhotoAnnouncement('Preparing photo…');
                    setSpreadPhoto(null);
                    setSpreadPhotoName(file.name);
                    setQuestionSubmitted(false);
                    const current = () => alive.current && photoSelection.current === selection;
                    void prepareSpreadPhoto(file)
                      .then((dataUrl) => {
                        if (!current()) return;
                        setSpreadPhoto(dataUrl);
                        setSpreadPhotoName(file.name);
                        setPhotoAnnouncement(`Photo attached: ${file.name}.`);
                        setQuestionSubmitted(false);
                        setMessage(null);
                      })
                      .catch((error) => {
                        if (!current()) return;
                        setSpreadPhoto(null);
                        setSpreadPhotoName(null);
                        setPhotoAnnouncement('');
                        if (spreadInputRef.current) spreadInputRef.current.value = '';
                        setMessage({
                          tone: 'error',
                          text:
                            error instanceof Error
                              ? error.message
                              : 'Could not load the spread photo.',
                        });
                      })
                      .finally(() => {
                        if (!current()) return;
                        photoPreparing.current = false;
                        setPreparingPhoto(false);
                      });
                  }}
                />
                <div
                  className={`spread-attachment ${spreadPhoto || preparingPhoto ? 'has-photo' : ''}`}
                  data-testid={spreadPhoto || preparingPhoto ? 'spread-photo-preview' : undefined}
                >
                  <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                    {photoAnnouncement}
                  </p>
                  {spreadPhoto || preparingPhoto ? (
                    <div className="spread-photo-preview">
                      {spreadPhoto && <img src={spreadPhoto} alt="Uploaded tarot spread preview" />}
                      {preparingPhoto && <p className="photo-preparing">Preparing photo…</p>}
                    </div>
                  ) : (
                    <div className="spread-photo-empty">
                      <Art name="three-card-spread" className="spread-intro-art" />
                      <p>Illustration only</p>
                    </div>
                  )}
                  <div className="spread-photo-meta">
                    <div className="spread-file-description">
                      {(spreadPhoto || preparingPhoto) && (
                        <p>{spreadPhotoName ?? 'Spread photo attached'}</p>
                      )}
                      <p className="muted">JPEG, PNG or WebP · up to 10 MB</p>
                    </div>
                    <div className="spread-photo-actions">
                      <button
                        ref={choosePhotoRef}
                        type="button"
                        className="secondary choose-photo"
                        aria-describedby="reading-spread-photo-help reading-photo-processing"
                        disabled={busy}
                        onClick={() => spreadInputRef.current?.click()}
                      >
                        Choose photo
                      </button>
                      {(spreadPhoto || preparingPhoto) && (
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => {
                            clearPhoto();
                            setQuestionSubmitted(false);
                            choosePhotoRef.current?.focus();
                          }}
                        >
                          Remove photo
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
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
            </div>
            <aside className="reading-preflight" aria-labelledby="reading-preflight-title">
              <h3 id="reading-preflight-title">Before you start</h3>
              <p id="reading-photo-processing">{photoNotice}</p>
              {submitNotice && <p>{submitNotice}</p>}
              <p>{READING_PRODUCT_COPY.startProcessing}</p>
              <div className="new-reading-footer">
                <button
                  type="submit"
                  className="large"
                  disabled={
                    busy ||
                    preparingPhoto ||
                    !english ||
                    !question.trim() ||
                    !user.permission.modelAllowed ||
                    live === null
                  }
                >
                  Start reading
                  <Icon name="chevron" />
                </button>
                <p className="muted">
                  Readings left: {user.remainingDay} today · {user.remainingMonth} this month.
                </p>
              </div>
            </aside>
          </div>
        </form>
      )}
      {mode === 'reading' && record && reading && (
        <section className="reading-detail" aria-label="Reading detail">
          <article
            data-testid="accepted-reading"
            className={`accepted-reading${reading.spreadPhoto ? ' has-spread-photo' : ''}`}
          >
            <div className="reading-header">
              <div className="reading-title">
                <p className="test-notice">
                  {reading.provenance.provider === 'openai'
                    ? 'AI reading'
                    : localRuntime
                      ? 'Local simulated reading'
                      : 'Simulated reading'}
                  {reading.mode === 'template' ? ' · Prepared reflection template' : ''}
                </p>
                <time dateTime={record.createdAt}>{date(record.createdAt)}</time>
                <h2 ref={resultHeading} tabIndex={-1}>
                  {reading.question}
                </h2>
              </div>
              {!reading.spreadPhoto && <Art name="study-inquiry" className="question-art" />}
            </div>
            {reading.spreadPhoto && (
              <figure
                className="card spread-photo-card"
                data-testid="spread-photo-card"
                aria-labelledby="reading-spread-caption"
              >
                <img
                  src={reading.spreadPhoto}
                  alt="Uploaded tarot spread for this reading"
                  className="spread-photo-image"
                />
                <figcaption id="reading-spread-caption" className="muted">
                  Uploaded spread photo · Recognized 3-card spread (situation, tension, possibility)
                </figcaption>
              </figure>
            )}
            {reading.units.map((unit, index) => {
              const card = reading.basis.cards.find((item) => item.position === unit.position);
              const name =
                reading.kind === 'tarot.accepted.v2'
                  ? reading.draw.find((item) => item.position === unit.position)?.name
                  : card && cardName(reading.basis.deckEdition, card.cardId);
              return (
                <section key={unit.position} className="card position-card">
                  <div className="position-title">
                    <span className="position-number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <h3>{unit.position}</h3>
                  </div>
                  <div className="position-body">
                    {card && !reading.spreadPhoto && (
                      <CardFace cardId={card.cardId} orientation={card.orientation} name={name} />
                    )}
                    <div className="position-copy">
                      <div>
                        <h4>
                          {reading.spreadPhoto ? 'Recognized card' : 'Drawn card'}
                          {name ? `: ${name}` : ''}
                        </h4>
                        <p className="basis-text">{unit.basisText}</p>
                      </div>
                      <div>
                        <h4>Interpretation</h4>
                        <p>{unit.interpretation}</p>
                      </div>
                      {'reflectionQuestion' in unit && (
                        <div className="reflection-prompt">
                          <h4>Reflection prompt</h4>
                          <p>{unit.reflectionQuestion}</p>
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              );
            })}
            {reading.kind === 'tarot.accepted.v2' ? (
              <div className="card reading-closing">
                <section>
                  <h3>Putting it together</h3>
                  <p>{reading.synthesis.text}</p>
                </section>
                <section>
                  <h3>An optional next step</h3>
                  <p>{reading.action.text}</p>
                </section>
                {reading.reflectionQuestion && (
                  <section className="reflection-prompt">
                    <h3>A question to consider</h3>
                    <p>{reading.reflectionQuestion.text}</p>
                  </section>
                )}
              </div>
            ) : (
              <p className="reading-closing">{reading.closing}</p>
            )}
            <details className="reading-sources">
              <summary>Cards and sources</summary>
              <h3>Traditional source material</h3>
              <p className="muted">
                These sources are saved with the reading. They are separate from the interpretation
                and your own reflection. These meanings are unapproved development material.
              </p>
              {reading.basis.cards.map((card, index) => {
                const name =
                  reading.kind === 'tarot.accepted.v2'
                    ? reading.draw[index]!.name
                    : cardName(reading.basis.deckEdition, card.cardId);
                const position = card.position[0]!.toUpperCase() + card.position.slice(1);
                return (
                  <div key={card.id} className="source">
                    <CardThumbnail cardId={card.cardId} orientation={card.orientation} />
                    <div className="source-copy">
                      <h3>
                        {position}: {name ? `${name} (${card.cardId})` : card.cardId} ·{' '}
                        {card.orientation}
                      </h3>
                      {reading.kind === 'tarot.accepted.v2' ? (
                        <>
                          <p>{reading.sources[index]!.meaning.core}</p>
                          <ul>
                            {reading.sources[index]!.meaning.distinctions.map((text) => (
                              <li key={text}>{text}</li>
                            ))}
                          </ul>
                          <p>{reading.sources[index]!.meaning.positive}</p>
                          <p>{reading.sources[index]!.meaning.limits.join(' ')}</p>
                          {reading.sources[index]!.meaning.imagery && (
                            <p>
                              {reading.sources[index]!.meaning.imagery!.text} —{' '}
                              {reading.sources[index]!.meaning.imagery!.reference}
                            </p>
                          )}
                        </>
                      ) : (
                        <p>{reading.sources[index]!.text}</p>
                      )}
                      <p className="source-attribution">
                        {reading.sources[index]!.rights.attribution}
                      </p>
                      <p className="muted source-id">
                        Source {reading.sources[index]!.id} · version{' '}
                        {reading.sources[index]!.version}
                      </p>
                    </div>
                  </div>
                );
              })}
              <p className="muted">
                {reading.mode === 'template'
                  ? 'Prepared reflection template.'
                  : reading.provenance.provider === 'openai'
                    ? 'Generated by OpenAI.'
                    : runtimeMode === 'hosted-synthetic'
                      ? 'Generated by the hosted simulation.'
                      : localRuntime
                        ? 'Generated by the local simulation.'
                        : 'Generated by a simulation.'}{' '}
                This saved text is not rewritten when you return.
              </p>
            </details>
          </article>
          <div className={`save-reading ${record.status === 'saved' ? 'is-saved' : ''}`}>
            {record.status === 'saved' ? (
              <p className="saved-label">
                <Icon name="check" />
                Saved until you delete it.
              </p>
            ) : (
              <>
                <div className="save-summary">
                  <Icon name="clock" />
                  <div className="save-copy">
                    <p>
                      <strong>Not saved</strong> · Temporary storage lasts 24 hours from creation.
                    </p>
                    <p className="muted">{READING_PRODUCT_COPY.saveReading}</p>
                  </div>
                </div>
                <button type="button" onClick={save} disabled={busy}>
                  <Icon name="bookmark" />
                  Save reading
                </button>
              </>
            )}
          </div>
          <section className="card reflection-editor" aria-label="Personal reflection">
            <h2>{reflection ? 'Edit reflection' : 'Add reflection'}</h2>
            <p>
              This is your own writing. It does not change the reading or request AI generation.
            </p>
            {reading.spreadPhoto && (
              <figure className="reflection-spread-reference">
                <img
                  src={reading.spreadPhoto}
                  alt="Your uploaded spread, for reference while writing"
                />
                <figcaption>Your uploaded spread</figcaption>
              </figure>
            )}
            {conflict && (
              <div className="notice reflection-conflict">
                <p>
                  Current saved reflection
                  {latestReflection ? ` (revision ${latestReflection.revision})` : ''}:
                </p>
                <blockquote>{latestReflection?.text ?? 'No saved reflection.'}</blockquote>
                <p>Saved response: {stanceLabels[latestReflection?.stance ?? 'unspecified']}</p>
                <div className="actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setReflection(latestReflection);
                      setLatestReflection(null);
                      setConflict(false);
                      setMessage({
                        tone: 'notice',
                        text: 'Your draft is ready for the next save.',
                      });
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
                      setMessage({
                        tone: 'notice',
                        text: 'The saved reflection is now in the editor.',
                      });
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
            <div className="select-field">
              <select
                id="reflection-stance"
                value={stance}
                onChange={(event) => setStance(event.target.value as Thought['stance'])}
                disabled={busy}
              >
                {Object.entries(stanceLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
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
          {reflection && (
            <details className="deletion-actions reflection-revisions">
              <summary>Reflection revisions</summary>
              <div className="revision-controls">
                <div className="revision-select">
                  <label htmlFor="reflection-revision">Saved reflection revision</label>
                  <div className="select-field">
                    <select
                      id="reflection-revision"
                      value={revisionChoice}
                      onChange={(event) => {
                        setRevisionChoice(Number(event.target.value));
                        setRevisionNote(null);
                        setEraseRevisionChecked(false);
                      }}
                      disabled={busy}
                    >
                      {Array.from({ length: reflection.revision }, (_, i) => i + 1).map((value) => (
                        <option key={value} value={value}>
                          Revision {value}
                          {value === reflection.revision ? ' (current)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <button type="button" className="secondary" onClick={viewRevision} disabled={busy}>
                  <Icon name="eye" />
                  View revision
                </button>
              </div>
              {revisionNote && (
                <div className="notice revision-note">
                  <p>
                    Saved revision {revisionNote.revision} · {date(revisionNote.updatedAt)}
                  </p>
                  <blockquote>{revisionNote.text}</blockquote>
                  <p>
                    Erasing this revision keeps the reading and other authored revisions. Erasing
                    the current revision removes it from the editor; older revisions remain
                    available in export.
                  </p>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={eraseRevisionChecked}
                      onChange={(event) => setEraseRevisionChecked(event.target.checked)}
                      disabled={busy}
                    />
                    Permanently erase this reflection revision
                  </label>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy || !eraseRevisionChecked}
                    onClick={eraseRevision}
                  >
                    Erase revision {revisionNote.revision}
                  </button>
                </div>
              )}
            </details>
          )}
          {revisionReceipt && (
            <DeletionReceiptPanel
              key={revisionReceipt.proof.receiptId}
              {...revisionReceipt}
              onDismiss={() => setRevisionReceipt(null)}
            />
          )}
          <div className="deletion-actions reading-deletion">
            {!confirmDelete ? (
              <button
                ref={deleteTrigger}
                type="button"
                className="text-button"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
              >
                <Icon name="delete" />
                Delete reading
              </button>
            ) : (
              <div className="notice delete-confirmation">
                <p>
                  This deletes the reading and its reflections. Downloaded files cannot be removed.
                  Backups are deleted on their own schedule.
                </p>
                <label className="check">
                  <input
                    ref={deleteConfirmation}
                    type="checkbox"
                    checked={deleteChecked}
                    onChange={(event) => setDeleteChecked(event.target.checked)}
                    disabled={busy}
                  />
                  Delete this reading and its reflections permanently
                </label>
                <div className="actions">
                  <button
                    type="button"
                    className="danger"
                    onClick={remove}
                    disabled={busy || !deleteChecked}
                  >
                    Confirm deletion
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      restoreDeleteFocus.current = true;
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
