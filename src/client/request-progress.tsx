import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { apiSchemas, Id } from '../contracts/index.ts';
import { api, ApiFailure } from './api.ts';

type Status = z.infer<typeof apiSchemas.RequestStatus>;
type View = z.infer<typeof apiSchemas.SessionView>;
export interface ReadingRequest {
  target: { kind: 'intent' | 'request'; id: string };
  start?: { input: z.infer<typeof apiSchemas.StartRequest>; key: string };
  focus: boolean;
}
export function requestFromPath(): ReadingRequest | null {
  const match = window.location.pathname.match(/^\/(requests|request-intents)\/([^/]+)$/);
  if (!match || !Id.safeParse(match[2]).success) return null;
  return {
    target: { kind: match[1] === 'requests' ? 'request' : 'intent', id: match[2]! },
    focus: false,
  };
}
export function requestPath(target: ReadingRequest['target']) {
  return `/${target.kind === 'request' ? 'requests' : 'request-intents'}/${target.id}`;
}
const terminal = (status: Status) =>
  ['published', 'blocked', 'failed', 'expired', 'cancelled'].includes(status.state);
function description(status: Status | null) {
  if (!status) return 'Recording your reading request…';
  if (status.state === 'published') return 'Your reading is ready.';
  if (status.state === 'cancelled') return 'Reading cancelled. No reading allowance was used.';
  if (status.state === 'expired')
    return 'This reading request expired. No reading allowance was used.';
  if (status.errorCode === 'CONSENT_REQUIRED')
    return 'AI permission was turned off. This request stopped; your saved readings remain available.';
  if (status.errorCode === 'PROVIDER_REFUSAL')
    return 'The writer declined this question. No reading was created. You can change the question for a new reading.';
  if (status.errorCode === 'PROVIDER_UNCERTAIN')
    return 'The writer did not confirm a result. This can happen after a timeout or lost connection. This request will not be sent again automatically.';
  if (status.errorCode === 'PROVIDER_UNAVAILABLE')
    return 'The writer is unavailable. No reading was created and no reading allowance was used.';
  if (status.state === 'failed' || status.state === 'blocked')
    return 'This request could not produce a reading. Your saved readings remain available.';
  if (status.state === 'dispatching') return 'Writing your reading…';
  if (status.state === 'received' || status.state === 'validating') return 'Checking your reading…';
  if (status.state === 'fallback_pending') return 'Preparing a template reading…';
  if (status.state === 'uncertain') return 'Waiting for a confirmed result…';
  return 'Preparing your three-card reading…';
}

/** A single mounted request owns its polling, cancellation and transient mutation input. */
export function RequestProgress(props: {
  request: ReadingRequest;
  user: View;
  onAccepted: (sessionId: string, focus: boolean) => void;
  onSession: (view: View) => void;
  onExpired: () => void;
  onAllowNew: () => void;
}) {
  const latest = useRef(props);
  latest.current = props;
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const actions = useRef({ check: () => {}, cancel: () => {}, retry: () => {} });
  useEffect(() => {
    const initial = latest.current.request;
    const controller = new AbortController();
    let live = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    let target = initial.target,
      snapshot: Status | null = null,
      cursor = 0;
    let polls = 0,
      reading = false,
      submitting = false,
      opening = false,
      stopping = false,
      definite = false;
    let cancelIntent: { revision: number; key: string } | null = null;
    const current = () => live && !controller.signal.aborted;
    const receive = (value: Status) => {
      if (!current() || (snapshot && value.revision < snapshot.revision)) return;
      snapshot = value;
      cursor = Math.max(cursor, value.nextSequence);
      target = { kind: 'request', id: value.requestId };
      window.history.replaceState(null, '', requestPath(target));
      setStatus(value);
      setNotice('');
      setCanRetry(false);
      if (terminal(value)) {
        latest.current.onAllowNew();
        if (value.state !== 'published')
          void api('/me', apiSchemas.SessionView, undefined, undefined, {
            signal: controller.signal,
          })
            .then((view) => {
              if (current()) latest.current.onSession(view);
            })
            .catch(() => undefined);
      }
      if (value.state === 'published' && !opening) {
        opening = true;
        latest.current.onAccepted(value.sessionId, initial.focus);
      }
    };
    const lost = (error: unknown, submission = false) => {
      if (!current()) return;
      if (error instanceof ApiFailure && error.status === 401) {
        latest.current.onExpired();
        return;
      }
      if (error instanceof ApiFailure && error.status === 410) {
        definite = true;
        latest.current.onAllowNew();
        setNotice('This reading is no longer available. It has not been regenerated.');
      } else if (
        submission &&
        error instanceof ApiFailure &&
        error.status < 500 &&
        error.status !== 429
      ) {
        definite = true;
        latest.current.onAllowNew();
        setNotice(error.message);
      } else if (error instanceof ApiFailure && error.status === 404) {
        latest.current.onAllowNew();
        setNotice(
          'This request has not been found yet. It may still arrive. Check again before starting another reading.',
        );
        setCanRetry(Boolean(initial.start) && !submitting);
      } else {
        setNotice('Connection lost; work may continue. Reconnect to check this same request.');
        setCanRetry(Boolean(initial.start) && !snapshot && !submitting);
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      if (current() && !definite && (!snapshot || !terminal(snapshot)))
        timer = setTimeout(
          () => {
            void check();
          },
          polls < 3 ? 2000 : polls < 6 ? 4000 : 10000,
        );
    };
    const check = async () => {
      if (!current() || reading || document.hidden || definite) return;
      clearTimeout(timer);
      reading = true;
      try {
        const path =
          target.kind === 'request'
            ? `/requests/${target.id}?after=${cursor}`
            : `/requests?intentId=${target.id}&after=${cursor}`;
        receive(
          await api(path, apiSchemas.RequestStatus, undefined, undefined, {
            signal: controller.signal,
          }),
        );
      } catch (error) {
        lost(error);
      } finally {
        reading = false;
        polls++;
        schedule();
      }
    };
    const submit = async () => {
      if (!initial.start || submitting || snapshot || !current()) return;
      submitting = true;
      setCanRetry(false);
      try {
        const value = await api(
          '/requests',
          apiSchemas.StartResponse,
          initial.start.input,
          latest.current.user.csrfToken,
          { key: initial.start.key, signal: controller.signal },
        );
        receive(value.status);
      } catch (error) {
        submitting = false;
        lost(error, true);
      } finally {
        submitting = false;
        schedule();
      }
    };
    const cancel = async () => {
      if (!snapshot || terminal(snapshot) || stopping || !current()) return;
      stopping = true;
      setCancelling(true);
      cancelIntent ??= { revision: snapshot.revision, key: crypto.randomUUID() };
      try {
        receive(
          await api(
            `/requests/${snapshot.requestId}/cancel`,
            apiSchemas.RequestStatus,
            {},
            latest.current.user.csrfToken,
            { revision: cancelIntent.revision, key: cancelIntent.key, signal: controller.signal },
          ),
        );
      } catch (error) {
        if (error instanceof ApiFailure && error.status === 409) cancelIntent = null;
        lost(error);
        // Both a lost response and a publication race are resolved by observation, never a new Start.
        await check();
      } finally {
        stopping = false;
        if (current()) setCancelling(false);
        schedule();
      }
    };
    actions.current = {
      check: () => {
        void check();
      },
      cancel: () => {
        void cancel();
      },
      retry: () => {
        void submit();
      },
    };
    const resume = () => {
      if (!document.hidden) {
        polls = 0;
        void check();
      }
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    if (initial.start) {
      void submit();
      schedule();
    } else {
      void check();
    }
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, []);
  return (
    <section aria-label="Reading request">
      <h2>Reading progress</h2>
      <p role="status" aria-live="polite" aria-atomic="true">
        {notice || description(status)}
      </p>
      <p className="muted">
        Only the accepted reading is shown. Reconnecting checks this request without starting
        another reading.
      </p>
      {status && !terminal(status) && (
        <button
          type="button"
          className="secondary"
          disabled={cancelling}
          onClick={() => actions.current.cancel()}
        >
          Cancel reading
        </button>
      )}
      {notice && (
        <button type="button" className="secondary" onClick={() => actions.current.check()}>
          Check request again
        </button>
      )}
      {canRetry && (
        <button type="button" onClick={() => actions.current.retry()}>
          Retry the same Start
        </button>
      )}
      {status?.state === 'published' && (
        <button type="button" onClick={() => latest.current.onAccepted(status.sessionId, true)}>
          Open reading
        </button>
      )}
    </section>
  );
}
