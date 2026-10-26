/** Dispatch only to the pinned Wrangler loopback scheduled-event adapter. */
export async function dispatchLocalMaintenance(): Promise<void> {
  const response = await fetch('http://localhost:8787/__scheduled?cron=*+*+*+*+*', {
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok || (await response.text()) !== 'Ran scheduled event') {
    throw new Error('Local scheduled handler did not complete');
  }
}
export function startLocalMaintenance(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await dispatchLocalMaintenance();
    } catch {
      console.warn('Local identity maintenance unavailable; it will retry.');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 1_000);
  const interval = setInterval(() => void tick(), 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}
