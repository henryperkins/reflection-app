import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { apiSchemas, type AuthResult } from '../contracts/index.ts';
import { READING_PRODUCT_COPY, SPREAD_PHOTO_COPY } from '../contracts/product-copy.ts';
import { api, ApiFailure } from './api.ts';
import { enroll, signIn } from './passkeys.ts';
import { ReadingWorkspace, type WorkspaceHandle, type WorkspaceResume } from './readings.tsx';
import { requestFromPath } from './request-progress.tsx';
import { deletionIntent, DeletionReceiptPanel, type DeletionProof } from './deletion.tsx';
import { date } from './date.ts';
import { Notice, type NoticeMessage } from './notice.tsx';
import { Art } from './art.tsx';
import { Icon } from './icon.tsx';

type View = z.infer<typeof apiSchemas.SessionView>;
type Kit = z.infer<typeof apiSchemas.RecoveryCodes>;
type Grant = z.infer<typeof apiSchemas.RecoveryGrant>;
function kitText(kit: Kit) {
  return JSON.stringify(
    {
      format: 'reflection-recovery-kit.v1',
      origin: window.location.origin,
      instructions: `Visit ${window.location.origin}/recover. Enter the recovery handle and one unused code, then create a replacement passkey. Keep this complete kit somewhere private. It contains no server encryption keys.`,
      recoveryHandle: kit.recoveryHandle,
      codes: kit.codes,
    },
    null,
    2,
  );
}
function downloadFile(name: string, chunks: BlobPart[], type: string) {
  const url = URL.createObjectURL(new Blob(chunks, { type })),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Modified clicks keep the browser's own link behavior, such as opening a new tab. */
function plainClick(event: MouseEvent) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
export function IdentityApp() {
  const [live, setLive] = useState<boolean | null>(null);
  useEffect(() => {
    void fetch('/health', { cache: 'no-store' })
      .then((response) => response.json())
      .then((runtime) => {
        if (typeof runtime === 'object' && runtime !== null && 'mode' in runtime) {
          const ready = 'generationReady' in runtime && runtime.generationReady === true;
          if (runtime.mode === 'live-local' || runtime.mode === 'live-preview') setLive(true);
          if (runtime.mode === 'synthetic-only') setLive(false);
          if (ready && ['synthetic-local', 'hosted-synthetic'].includes(String(runtime.mode)))
            setLive(false);
          if (
            ready &&
            runtime.mode === 'production' &&
            'provider' in runtime &&
            runtime.provider === 'openai'
          )
            setLive(true);
        }
      })
      .catch(() => {});
  }, []);
  const [session, setSession] = useState<View | null>(null);
  const [kit, setKit] = useState<Kit | null>(null);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [credentials, setCredentials] = useState<z.infer<typeof apiSchemas.Credentials> | null>(
    null,
  );
  const [route, setRoute] = useState(window.location.pathname);
  const [readingResume, setReadingResume] = useState<WorkspaceResume | null>(null);
  const readingsPath = readingResume?.path ?? '/';
  const [busy, setBusy] = useState(false),
    [checking, setChecking] = useState(true);
  const [message, setMessage] = useState<NoticeMessage | null>(null);
  const [accountDeleteChecked, setAccountDeleteChecked] = useState(false);
  const [deletionReceipt, setDeletionReceipt] = useState<{
    proof: DeletionProof;
    initial: z.infer<typeof apiSchemas.DeletionStatus> | null;
  } | null>(null);
  const [handle, setHandle] = useState(''),
    [code, setCode] = useState('');
  const [downloaded, setDownloaded] = useState(false),
    [acknowledged, setAcknowledged] = useState(false);
  const inFlight = useRef(false);
  const authenticated = useRef(false);
  const workspace = useRef<WorkspaceHandle>(null);
  const permissionIntent = useRef<{ payload: string; key: string } | null>(null);
  useEffect(() => {
    authenticated.current = Boolean(session || kit);
  }, [session, kit]);
  const version = useRef(0),
    channel = useRef<BroadcastChannel | null>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const clear = useCallback(() => {
    version.current++;
    inFlight.current = false;
    authenticated.current = false;
    permissionIntent.current = null;
    setBusy(false);
    setChecking(false);
    setSession(null);
    setKit(null);
    setGrant(null);
    setCredentials(null);
    setReadingResume(null);
    setHandle('');
    setCode('');
    setDownloaded(false);
    setAcknowledged(false);
    setAccountDeleteChecked(false);
    setDeletionReceipt(null);
    try {
      sessionStorage.clear();
    } catch {
      /* Browser storage may be unavailable. */
    }
    if ('caches' in window)
      void caches
        .keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .catch(() => {});
    navigator.serviceWorker?.controller?.postMessage({ type: 'PURGE_PRIVATE' });
  }, []);
  useEffect(() => {
    if (!session || kit || busy || route !== '/account') return;
    let current = true;
    setCredentials(null);
    void api('/auth/credentials', apiSchemas.Credentials)
      .then((listed) => {
        if (current) setCredentials(listed);
      })
      .catch((error) => {
        if (!current) return;
        if (error instanceof ApiFailure && error.status === 401) clear();
        else
          setMessage({
            tone: 'error',
            text: 'Your passkeys could not be loaded. Refresh this page to try again.',
          });
      });
    return () => {
      current = false;
    };
  }, [session, kit, busy, route, clear]);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    const requested = version.current;
    setChecking(true);
    try {
      const current = await api('/me', apiSchemas.SessionView);
      if (requested === version.current) setSession(current);
    } catch (error) {
      if (requested === version.current) {
        if (error instanceof ApiFailure && error.status === 401) {
          if (authenticated.current) clear();
        } else {
          setMessage({
            tone: 'error',
            text: 'Your session could not be refreshed. Keep this page open and try again when the connection returns.',
          });
        }
      }
    } finally {
      if (requested === version.current) setChecking(false);
    }
  }, [clear]);
  const leaveReadings = useCallback(() => {
    const current = workspace.current;
    if (!current) return true;
    if (!current.confirmLeave()) return false;
    setReadingResume(current.getResumeState());
    return true;
  }, []);
  useEffect(() => {
    void refresh();
    const updates = new BroadcastChannel('reflection-account');
    channel.current = updates;
    updates.onmessage = () => {
      clear();
      setMessage({
        tone: 'notice',
        text: 'Your account session changed in another tab. Please sign in again.',
      });
    };
    const focus = () => {
        if (authenticated.current) void refresh();
      },
      navigation = () => {
        // The account page closes the readings, so unsaved writing there needs a choice first.
        if (window.location.pathname === '/account' && !leaveReadings()) return;
        setRoute(window.location.pathname);
        setMessage(null);
      };
    const pageshow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        clear();
        void refresh();
      }
    };
    window.addEventListener('focus', focus);
    window.addEventListener('popstate', navigation);
    window.addEventListener('pageshow', pageshow);
    return () => {
      updates.close();
      window.removeEventListener('focus', focus);
      window.removeEventListener('popstate', navigation);
      window.removeEventListener('pageshow', pageshow);
    };
  }, [refresh, clear, leaveReadings]);
  const navigate = (path: string) => {
    history.pushState(null, '', path);
    setRoute(path);
  };
  const run = async (operation: (isCurrent: () => boolean) => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const operationVersion = ++version.current;
    const isCurrent = () => operationVersion === version.current;
    setBusy(true);
    setMessage(null);
    try {
      await operation(isCurrent);
      requestAnimationFrame(() => {
        if (isCurrent()) heading.current?.focus();
      });
    } catch (error) {
      if (isCurrent())
        setMessage({
          tone: 'error',
          text:
            error instanceof ApiFailure
              ? error.status >= 500 && error.correlationId
                ? `${error.message} Reference: ${error.correlationId}`
                : error.message
              : error instanceof Error && error.message
                ? error.message
                : 'The passkey action was not completed. Please try again.',
        });
    } finally {
      if (isCurrent()) {
        inFlight.current = false;
        setBusy(false);
        setChecking(false);
      }
    }
  };
  const receiveKit = (value: Kit) => {
    setKit(value);
    setDownloaded(false);
    setAcknowledged(false);
  };
  const readSession = async (isCurrent: () => boolean) =>
    api('/me', apiSchemas.SessionView).catch((error) => {
      if (isCurrent() && error instanceof ApiFailure && error.status === 401) clear();
      throw error;
    });
  const complete = async (result: z.infer<typeof AuthResult>, isCurrent: () => boolean) => {
    if (!isCurrent()) return;
    setDeletionReceipt(null);
    // Preserve the one-time kit even if the follow-up session read is temporarily unavailable.
    if (result.recoveryHandle)
      receiveKit({ recoveryHandle: result.recoveryHandle, codes: result.recoveryCodes });
    const current = await readSession(isCurrent);
    if (!isCurrent()) return;
    setSession(current);
    setGrant(null);
    // Saved readings are the default destination; a requested reading or the account page stays.
    if (!requestFromPath() && window.location.pathname !== '/account') navigate('/');
  };
  const verifyExistingPasskey = async (isCurrent: () => boolean) => {
    if (!session) throw new Error('Your session has ended. Sign in again.');
    const verified = await signIn('reauthenticate', session.csrfToken);
    if (!isCurrent()) return null;
    // Keep the rotated session usable if the following passkey prompt is cancelled.
    setSession({
      ...session,
      csrfToken: verified.csrfToken,
      recentAuthUntil: verified.recentAuthUntil,
    });
    channel.current?.postMessage('changed');
    return verified.csrfToken;
  };
  const download = () => {
    if (!kit) return;
    downloadFile('reflection-recovery-kit.json', [kitText(kit)], 'application/json');
    setDownloaded(true);
  };
  const expire = () => {
    clear();
    setMessage({ tone: 'notice', text: 'Your session ended. Please sign in again.' });
  };
  // Record routes answer 401 only once the session has ended.
  const expireIfEnded = (error: unknown, isCurrent: () => boolean) => {
    if (isCurrent() && error instanceof ApiFailure && error.status === 401) expire();
  };
  const show = (path: string) => {
    navigate(path);
    setMessage(null);
    requestAnimationFrame(() => heading.current?.focus());
  };
  const openAccount = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    if (route === '/account' || inFlight.current) return;
    if (!leaveReadings()) return;
    show('/account');
  };
  const backToReadings = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    if (!inFlight.current) show(readingsPath);
  };
  const permission = () =>
    void run(async (isCurrent) => {
      if (!session) return;
      const { permission: previous, csrfToken } = session;
      const payload = { modelAllowed: !previous.modelAllowed, policyVersion: 'egress.v1' as const };
      const intent = JSON.stringify([payload, previous.revision]);
      // A retry of the same change reuses its idempotency key.
      if (permissionIntent.current?.payload !== intent)
        permissionIntent.current = { payload: intent, key: crypto.randomUUID() };
      await api('/permissions/model', apiSchemas.Permission, payload, csrfToken, {
        method: 'PUT',
        revision: previous.revision,
        key: permissionIntent.current.key,
      }).catch((error: unknown) => {
        expireIfEnded(error, isCurrent);
        throw error;
      });
      if (!isCurrent()) return;
      permissionIntent.current = null;
      const updated = await readSession(isCurrent);
      if (isCurrent()) setSession(updated);
    });
  const exportRecords = () =>
    void run(async (isCurrent) => {
      if (!session) return;
      let view = session;
      if (Date.parse(view.recentAuthUntil) <= Date.now()) {
        await signIn('reauthenticate', view.csrfToken);
        if (!isCurrent()) return;
        view = await readSession(isCurrent);
        if (!isCurrent()) return;
        setSession(view);
      }
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      try {
        const ticket = await api('/exports', apiSchemas.ExportTicket, {}, view.csrfToken, {
          key: crypto.randomUUID(),
        });
        let cursor: string | null = null,
          bytes = 0;
        do {
          if (!isCurrent()) return;
          const page: z.infer<typeof apiSchemas.ExportPage> = await api(
            `/exports/${ticket.id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
            apiSchemas.ExportPage,
          );
          if (!isCurrent()) return;
          const chunk = new TextEncoder().encode(`${JSON.stringify(page)}\n`);
          bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024)
            throw new Error(
              'This export is too large for the local build. No partial file was downloaded.',
            );
          chunks.push(chunk);
          cursor = page.nextCursor;
        } while (cursor);
      } catch (error) {
        expireIfEnded(error, isCurrent);
        throw error;
      }
      if (!isCurrent()) return;
      downloadFile('reflection-export.ndjson', chunks, 'application/x-ndjson');
      setMessage({
        tone: 'success',
        text: 'Export downloaded. Keep it somewhere private; deleting records here cannot delete downloaded copies.',
      });
    });
  const accountPage = Boolean(session) && !kit && !grant && route === '/account';
  const title = kit
    ? 'Keep your recovery kit'
    : grant
      ? 'Create your replacement passkey'
      : session
        ? accountPage
          ? 'Your account'
          : 'Your readings'
        : route === '/recover'
          ? 'Recover your account'
          : 'A place to return to.';
  const authPage = !kit && (Boolean(grant) || !session);
  const landing = authPage && !grant && route !== '/recover';
  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="shell-width">
          <a className="brand" href="/">
            <span className="brand-mark">
              <Icon name="brand" />
            </span>
            Reflection
          </a>
          <div className="header-tools">
            <span className="test-label">Development build</span>
            {session && !kit && !grant && (
              <a
                className="header-link"
                href="/account"
                aria-current={accountPage ? 'page' : undefined}
                onClick={openAccount}
              >
                Account
              </a>
            )}
          </div>
        </div>
      </header>
      <main
        className={authPage ? 'auth-layout' : `page-column ${kit ? 'kit-page' : 'account-page'}`}
      >
        {authPage && <Art name={landing ? 'study-return' : 'study-inquiry'} className="auth-art" />}
        <div className={authPage ? 'auth-column' : 'page-stack'}>
          <div
            className={
              authPage
                ? `card auth-card ${landing ? 'landing-card' : 'recovery-card'} ${grant ? 'replacement-card' : ''}`
                : 'page-panel'
            }
          >
            {accountPage && (
              <a
                className="back-link"
                href={readingsPath}
                aria-disabled={busy || undefined}
                onClick={backToReadings}
              >
                <Icon name="chevron" />
                Back to readings
              </a>
            )}
            <div className="page-title">
              <div className="title-copy">
                <p className="eyebrow">A private space for reflection</p>
                <h1 ref={heading} tabIndex={-1}>
                  {title}
                </h1>
                <p className="test-notice">
                  {live === null
                    ? 'Reading service status is unavailable. Saved readings remain available.'
                    : live
                      ? 'Live AI readings are enabled for this development app.'
                      : 'Use synthetic text and test accounts only. This local build simulates readings and never contacts an AI provider.'}
                </p>
                {kit && (
                  <p className="lead">
                    Your kit contains a recovery handle and ten one-time codes. You need the handle
                    and one unused code if your passkeys are unavailable.
                  </p>
                )}
                {accountPage && (
                  <p className="lead">
                    You’re signed in. Your passkey and recovery kit protect access to this account.
                  </p>
                )}
              </div>
              {kit && <Art name="study-perspective" className="title-art" />}
              {!kit && !grant && session && (
                <Art name="study-stillness" className="title-art account-title-art" />
              )}
            </div>
            <Notice message={message} />
            <div className="identity-content" aria-busy={busy || checking}>
              {checking && !session && !kit && !grant ? (
                <p role="status" className="busy-line">
                  <span className="spinner" aria-hidden="true" />
                  Checking your session…
                </p>
              ) : kit ? (
                <section aria-label="Recovery kit" className="kit-content">
                  <div className="card kit-card">
                    <p className="callout">
                      <Icon name="warning" />
                      <span>
                        Keep the complete file somewhere private, outside this browser. Anyone with
                        the handle and an unused code can replace your passkey. This kit is shown
                        only once.
                      </span>
                    </p>
                    <details>
                      <summary>Show handle and recovery codes</summary>
                      <p className="recovery-handle">
                        <strong>Recovery handle</strong>
                        <code>{kit.recoveryHandle}</code>
                      </p>
                      <ol className="codes">
                        {kit.codes.map((item) => (
                          <li key={item}>
                            <code>{item}</code>
                          </li>
                        ))}
                      </ol>
                    </details>
                    <div className="actions">
                      <button type="button" onClick={download} disabled={busy}>
                        <Icon name="download" />
                        Download recovery kit
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(async (isCurrent) => {
                            await navigator.clipboard.writeText(kitText(kit));
                            if (!isCurrent()) return;
                            setDownloaded(true);
                            setMessage({
                              tone: 'success',
                              text: 'Complete recovery kit copied. Store it somewhere private.',
                            });
                          })
                        }
                      >
                        <Icon name="copy" />
                        Copy complete kit
                      </button>
                    </div>
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      onChange={(event) => setAcknowledged(event.target.checked)}
                    />
                    I have saved the complete kit with the handle and codes.
                  </label>
                  <button
                    type="button"
                    className="large"
                    disabled={!downloaded || !acknowledged || busy || !session}
                    onClick={() =>
                      void run(async (isCurrent) => {
                        await api('/auth/recovery/ack', apiSchemas.Empty, {}, session?.csrfToken);
                        if (!isCurrent()) return;
                        const current = await readSession(isCurrent);
                        if (!isCurrent()) return;
                        setKit(null);
                        setSession(current);
                        channel.current?.postMessage('changed');
                      })
                    }
                  >
                    Continue to account
                  </button>
                  <p className="muted">
                    The kit stays in memory here until you leave. Downloading or copying it is your
                    choice; it is never saved automatically in this browser.
                  </p>
                </section>
              ) : grant ? (
                <section className="replacement-content">
                  <p className="lead">
                    Your recovery code was verified. Create a new passkey to finish recovering your
                    account. This step expires after five minutes.
                  </p>
                  <p className="callout">
                    <Icon name="info" />
                    <span>
                      Completing recovery replaces your previous passkeys and recovery kit. Your
                      account stays the same.
                    </span>
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async (isCurrent) => {
                        await complete(await enroll(grant.options), isCurrent);
                      })
                    }
                  >
                    <Icon name="key" />
                    Create replacement passkey
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setGrant(null);
                      setMessage({
                        tone: 'notice',
                        text: 'Recovery enrollment cancelled. That code has been used; use a remaining code or an existing passkey.',
                      });
                    }}
                  >
                    Cancel enrollment
                  </button>
                </section>
              ) : session && accountPage ? (
                <section className="account-content">
                  <div className="consent">
                    <Art name="study-return" className="consent-art" />
                    <div className="consent-copy">
                      <h2>AI readings are {session.permission.modelAllowed ? 'on' : 'off'}</h2>
                      <p>{READING_PRODUCT_COPY.aiPermission}</p>
                      <p className="muted">
                        {live === null
                          ? 'Refresh to check the reading service before enabling AI. Your saved readings and reflections remain available.'
                          : live
                            ? SPREAD_PHOTO_COPY.liveProviderRetention
                            : READING_PRODUCT_COPY.providerRetention}
                      </p>
                      {!session.permission.modelAllowed && (
                        <p>
                          History, reopening, reflections, export and deletion remain available.
                        </p>
                      )}
                      <button
                        type="button"
                        className="secondary"
                        disabled={
                          busy || checking || (live === null && !session.permission.modelAllowed)
                        }
                        onClick={permission}
                      >
                        {session.permission.modelAllowed
                          ? 'Turn off AI readings'
                          : 'Enable AI readings'}
                      </button>
                    </div>
                  </div>
                  <section className="card passkeys-card" aria-label="Manage passkeys">
                    <h2>Your passkeys</h2>
                    <p>
                      Add a passkey on another device before removing one. You’ll verify an existing
                      passkey before each change. Changing passkeys signs out your other sessions.
                    </p>
                    {credentials ? (
                      <ul aria-label="Passkeys">
                        {credentials.items.map((credential) => (
                          <li key={credential.id}>
                            <span className="passkey-icon">
                              <Icon name="key" />
                            </span>
                            <p>
                              <strong>Passkey {credential.id.slice(0, 8)}</strong>
                              Added {date(credential.createdAt, true)}
                              {' · '}
                              {credential.backedUp
                                ? 'Backed up by your passkey provider'
                                : 'Not reported as backed up'}
                            </p>
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy || checking || credentials.items.length <= 1}
                              aria-label={`Remove passkey ${credential.id.slice(0, 8)}`}
                              onClick={() =>
                                void run(async (isCurrent) => {
                                  const csrf = await verifyExistingPasskey(isCurrent);
                                  if (!csrf || !isCurrent()) return;
                                  await api(
                                    `/auth/credentials/${credential.id}`,
                                    apiSchemas.Empty,
                                    {},
                                    csrf,
                                    { method: 'DELETE' },
                                  );
                                  if (!isCurrent()) return;
                                  const current = await readSession(isCurrent);
                                  if (!isCurrent()) return;
                                  setSession(current);
                                  channel.current?.postMessage('changed');
                                  setMessage({
                                    tone: 'success',
                                    text: 'Passkey removed. Your other sessions have been signed out.',
                                  });
                                })
                              }
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p role="status" className="busy-line">
                        <span className="spinner" aria-hidden="true" />
                        Loading your passkeys…
                      </p>
                    )}
                    {credentials?.items.length === 1 && (
                      <p>Keep at least one passkey on your account.</p>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || checking || !credentials || credentials.items.length >= 10}
                      onClick={() =>
                        void run(async (isCurrent) => {
                          const csrf = await verifyExistingPasskey(isCurrent);
                          if (!csrf || !isCurrent()) return;
                          const options = await api(
                            '/auth/options',
                            apiSchemas.AuthOptions,
                            { purpose: 'add' },
                            csrf,
                          );
                          if (!isCurrent()) return;
                          await complete(await enroll(options, csrf), isCurrent);
                          if (!isCurrent()) return;
                          channel.current?.postMessage('changed');
                          setMessage({
                            tone: 'success',
                            text: 'Passkey added. Your other sessions have been signed out.',
                          });
                        })
                      }
                    >
                      <Icon name="add" />
                      Add a passkey
                    </button>
                    {credentials?.items.length === 10 && (
                      <p>You have ten passkeys. Remove one before adding another.</p>
                    )}
                  </section>
                  <details className="deletion-actions">
                    <summary>Delete account</summary>
                    <p>
                      This permanently deletes your account, readings, reflections and passkeys.
                      Your recovery kit will no longer restore this account. Downloaded copies are
                      unchanged.
                    </p>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={accountDeleteChecked}
                        onChange={(event) => setAccountDeleteChecked(event.target.checked)}
                        disabled={busy}
                      />
                      Permanently delete my account, readings and reflections
                    </label>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy || !accountDeleteChecked}
                      onClick={() =>
                        void run(async (isCurrent) => {
                          let csrf = session.csrfToken;
                          if (Date.parse(session.recentAuthUntil) <= Date.now()) {
                            const verified = await signIn('reauthenticate', csrf);
                            if (!isCurrent()) return;
                            csrf = verified.csrfToken;
                          }
                          const intent = deletionIntent(),
                            proof = {
                              receiptId: intent.receiptId,
                              receiptToken: intent.receiptToken,
                            };
                          let initial: z.infer<typeof apiSchemas.DeletionStatus> | null = null;
                          try {
                            const receipt = await api(
                              '/account',
                              apiSchemas.DeletionReceipt,
                              proof,
                              csrf,
                              { method: 'DELETE', key: intent.key },
                            );
                            initial = {
                              state: receipt.state,
                              backupExpiresBy: receipt.backupExpiresBy,
                            };
                          } catch (error) {
                            // A network/5xx failure may follow the access fence; retain the scoped receipt.
                            if (error instanceof ApiFailure && error.status < 500) throw error;
                          }
                          if (!isCurrent()) return;
                          clear();
                          setDeletionReceipt({ proof, initial });
                          channel.current?.postMessage('signed-out');
                          navigate('/');
                        })
                      }
                    >
                      Delete account permanently
                    </button>
                  </details>
                  <p className="account-storage">
                    <Icon name="lock" />
                    <span>{READING_PRODUCT_COPY.serviceStorage}</span>
                  </p>
                  <div className="actions account-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={exportRecords}
                    >
                      <Icon name="download" />
                      Export my records
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(async (isCurrent) => {
                          const csrf = await verifyExistingPasskey(isCurrent);
                          if (!csrf || !isCurrent()) return;
                          const rotated = await api(
                            '/auth/recovery-codes',
                            apiSchemas.RecoveryCodes,
                            {},
                            csrf,
                          );
                          if (!isCurrent()) return;
                          receiveKit(rotated);
                          const current = await readSession(isCurrent);
                          if (!isCurrent()) return;
                          setSession(current);
                          channel.current?.postMessage('changed');
                        })
                      }
                    >
                      Replace recovery kit
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(async (isCurrent) => {
                          await api('/auth/logout', apiSchemas.Empty, {}, session.csrfToken);
                          if (!isCurrent()) return;
                          clear();
                          channel.current?.postMessage('signed-out');
                          navigate('/');
                        })
                      }
                    >
                      Sign out
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(async (isCurrent) => {
                          await api('/auth/logout-all', apiSchemas.Empty, {}, session.csrfToken);
                          if (!isCurrent()) return;
                          clear();
                          channel.current?.postMessage('signed-out');
                          navigate('/');
                        })
                      }
                    >
                      Sign out of all devices
                    </button>
                  </div>
                </section>
              ) : session ? (
                <div inert={checking || busy}>
                  <ReadingWorkspace
                    ref={workspace}
                    resume={readingResume}
                    live={live}
                    key={session.subjectId}
                    user={session}
                    onSession={setSession}
                    onExpired={expire}
                    onAccount={openAccount}
                  />
                </div>
              ) : route === '/recover' ? (
                <form
                  className="recovery-form"
                  autoComplete="off"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async (isCurrent) => {
                      const recovered = await api('/auth/recover', apiSchemas.RecoveryGrant, {
                        recoveryHandle: handle.trim(),
                        code: code.trim(),
                      });
                      if (!isCurrent()) return;
                      setGrant(recovered);
                      setHandle('');
                      setCode('');
                    });
                  }}
                >
                  <p className="lead">
                    Open the recovery kit you saved. Enter its handle and one unused code. A code
                    alone cannot identify your account.
                  </p>
                  <label htmlFor="recovery-handle">Recovery handle</label>
                  <input
                    id="recovery-handle"
                    value={handle}
                    onChange={(event) => setHandle(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="none"
                    required
                    maxLength={100}
                    disabled={busy}
                  />
                  <label htmlFor="recovery-code">Unused recovery code</label>
                  <input
                    id="recovery-code"
                    type="password"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    autoComplete="off"
                    required
                    maxLength={100}
                    disabled={busy}
                  />
                  <button type="submit" disabled={busy || !handle.trim() || !code.trim()}>
                    Verify recovery kit
                  </button>
                  <p className="muted recovery-note">
                    You’ll create a replacement passkey before you can access your account. If a
                    connection is interrupted after verification, that code may already be used; try
                    an existing passkey or another unused code.
                  </p>
                  <a href="/">Back to sign in</a>
                </form>
              ) : (
                <section className="landing-content">
                  <p className="lead">
                    Create a passkey to access your account without an email address or password.
                    Then save a complete recovery kit for the times your passkeys are unavailable.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async (isCurrent) => {
                          const options = await api('/auth/options', apiSchemas.AuthOptions, {
                            purpose: 'register',
                          });
                          await complete(await enroll(options), isCurrent);
                        })
                      }
                    >
                      {live === false ? 'Create a test account' : 'Create an account'}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(async (isCurrent) => {
                          await complete(await signIn('authenticate'), isCurrent);
                        })
                      }
                    >
                      <Icon name="key" />
                      Sign in with a passkey
                    </button>
                  </div>
                  <a href="/recover">Recover with your saved kit</a>
                </section>
              )}
              {busy && (
                <p role="status" className="busy-line">
                  <span className="spinner" aria-hidden="true" />
                  Completing your account action…
                </p>
              )}
            </div>
            {landing && <Art name="leaves" className="landing-leaves" />}
          </div>
          {deletionReceipt && (
            <DeletionReceiptPanel
              key={deletionReceipt.proof.receiptId}
              {...deletionReceipt}
              onDismiss={() => setDeletionReceipt(null)}
            />
          )}
        </div>
      </main>
      <footer className="site-footer">
        <p className="shell-width">
          No email or password is collected. Keep recovery files off shared devices.
        </p>
      </footer>
    </div>
  );
}
