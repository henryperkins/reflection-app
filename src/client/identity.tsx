import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { apiSchemas, type AuthResult } from '../contracts/index.ts';
import { api, ApiFailure } from './api.ts';
import { enroll, signIn } from './passkeys.ts';
import { ReadingWorkspace } from './readings.tsx';

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
export function IdentityApp() {
  const [session, setSession] = useState<View | null>(null);
  const [kit, setKit] = useState<Kit | null>(null);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [route, setRoute] = useState(window.location.pathname);
  const [busy, setBusy] = useState(false),
    [checking, setChecking] = useState(true);
  const [message, setMessage] = useState('');
  const [handle, setHandle] = useState(''),
    [code, setCode] = useState('');
  const [downloaded, setDownloaded] = useState(false),
    [acknowledged, setAcknowledged] = useState(false);
  const inFlight = useRef(false);
  const authenticated = useRef(false);
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
    setBusy(false);
    setChecking(false);
    setSession(null);
    setKit(null);
    setGrant(null);
    setHandle('');
    setCode('');
    setDownloaded(false);
    setAcknowledged(false);
  }, []);
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
          setMessage(
            'Your session could not be refreshed. Keep this page open and try again when the connection returns.',
          );
        }
      }
    } finally {
      if (requested === version.current) setChecking(false);
    }
  }, [clear]);
  useEffect(() => {
    void refresh();
    const updates = new BroadcastChannel('reflection-account');
    channel.current = updates;
    updates.onmessage = () => {
      clear();
      setMessage('Your account session changed in another tab. Please sign in again.');
    };
    const focus = () => {
        if (authenticated.current) void refresh();
      },
      navigation = () => {
        setRoute(window.location.pathname);
        setMessage('');
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
  }, [refresh, clear]);
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
    setMessage('');
    try {
      await operation(isCurrent);
      requestAnimationFrame(() => {
        if (isCurrent()) heading.current?.focus();
      });
    } catch (error) {
      if (isCurrent())
        setMessage(
          error instanceof ApiFailure
            ? error.message
            : 'The passkey action was not completed. Please try again.',
        );
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
    // Preserve the one-time kit even if the follow-up session read is temporarily unavailable.
    if (result.recoveryHandle)
      receiveKit({ recoveryHandle: result.recoveryHandle, codes: result.recoveryCodes });
    const current = await readSession(isCurrent);
    if (!isCurrent()) return;
    setSession(current);
    setGrant(null);
    navigate('/account');
  };
  const download = () => {
    if (!kit) return;
    const url = URL.createObjectURL(new Blob([kitText(kit)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'reflection-recovery-kit.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloaded(true);
  };
  const title = kit
    ? 'Keep your recovery kit'
    : grant
      ? 'Create your replacement passkey'
      : session
        ? 'Your account'
        : route === '/recover'
          ? 'Recover your account'
          : 'A place to return to.';
  return (
    <main>
      <header>
        <a className="brand" href="/">
          Reflection
        </a>
        <span className="test-label">Local test build</span>
      </header>
      <p className="eyebrow">A private space for reflection</p>
      <h1 ref={heading} tabIndex={-1}>
        {title}
      </h1>
      <p className="test-notice">
        Use synthetic text and test accounts only. This local build simulates readings and never
        contacts an AI provider.
      </p>
      {message && (
        <p role="alert" className="notice error">
          {message}
        </p>
      )}
      <div aria-busy={busy || checking}>
        {checking && !session && !kit && !grant ? (
          <p role="status">Checking your session…</p>
        ) : kit ? (
          <section aria-label="Recovery kit">
            <p>
              Your kit contains a recovery handle and ten one-time codes. You need the handle and
              one unused code if your passkeys are unavailable.
            </p>
            <p>
              Keep the complete file somewhere private, outside this browser. Anyone with the handle
              and an unused code can replace your passkey. This kit is shown only once.
            </p>
            <details>
              <summary>Show handle and recovery codes</summary>
              <p>
                <strong>Recovery handle</strong>
                <br />
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
                    setMessage('Complete recovery kit copied. Store it somewhere private.');
                  })
                }
              >
                Copy complete kit
              </button>
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
          <section>
            <p>
              Your recovery code was verified. Create a new passkey to finish recovering your
              account. This step expires after five minutes.
            </p>
            <p>
              Completing recovery replaces your previous passkeys and recovery kit. Your account
              stays the same.
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
              Create replacement passkey
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                setGrant(null);
                setMessage(
                  'Recovery enrollment cancelled. That code has been used; use a remaining code or an existing passkey.',
                );
              }}
            >
              Cancel enrollment
            </button>
          </section>
        ) : session ? (
          <section>
            <p>You’re signed in. Your passkey and recovery kit protect access to this account.</p>
            <div hidden={checking}>
              <ReadingWorkspace
                key={session.subjectId}
                user={session}
                onSession={setSession}
                onExpired={() => {
                  clear();
                  setMessage('Your session ended. Please sign in again.');
                }}
              />
            </div>
            <p>
              Storage is encrypted and readable by the service for authorized operations. This is
              not end-to-end encryption.
            </p>
            <div className="actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async (isCurrent) => {
                    const verified = await signIn('reauthenticate', session.csrfToken);
                    if (!isCurrent()) return;
                    const rotated = await api(
                      '/auth/recovery-codes',
                      apiSchemas.RecoveryCodes,
                      {},
                      verified.csrfToken,
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
            </div>
          </section>
        ) : route === '/recover' ? (
          <form
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
            <p>
              Open the recovery kit you saved. Enter its handle and one unused code. A code alone
              cannot identify your account.
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
            <p>
              You’ll create a replacement passkey before you can access your account. If a
              connection is interrupted after verification, that code may already be used; try an
              existing passkey or another unused code.
            </p>
            <a href="/">Back to sign in</a>
          </form>
        ) : (
          <section>
            <p>
              Create a passkey to access your account without an email address or password. Then
              save a complete recovery kit for the times your passkeys are unavailable.
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
                Create a test account
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
                Sign in with a passkey
              </button>
            </div>
            <a href="/recover">Recover with your saved kit</a>
          </section>
        )}
        {busy && <p role="status">Completing your account action…</p>}
      </div>
      <footer>No email or password is collected. Keep recovery files off shared devices.</footer>
    </main>
  );
}
