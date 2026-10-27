import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { apiSchemas } from '../contracts/index.ts';
import { date } from './date.ts';

export type DeletionProof = z.infer<typeof apiSchemas.DeleteRequest>;
type Status = z.infer<typeof apiSchemas.DeletionStatus>;
export function deletionIntent() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const receiptToken = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return { receiptId: crypto.randomUUID(), receiptToken, key: crypto.randomUUID() };
}
export function DeletionReceiptPanel({
  proof,
  initial,
  onDismiss,
}: {
  proof: DeletionProof;
  initial: Status | null;
  onDismiss: () => void;
}) {
  const [status, setStatus] = useState(initial),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const alive = useRef(true),
    inFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const check = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/v1/deletions/${proof.receiptId}`, {
        cache: 'no-store',
        headers: { 'X-Deletion-Token': proof.receiptToken },
      });
      if (!response.ok)
        throw new Error('Deletion is not confirmed yet. Keep your receipt and check again.');
      const current = apiSchemas.DeletionStatus.parse(await response.json());
      if (alive.current) setStatus(current);
    } catch (error) {
      if (alive.current)
        setMessage(error instanceof Error ? error.message : 'Status is temporarily unavailable.');
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const download = () => {
    const value = {
      format: 'reflection-deletion-receipt.v1',
      origin: window.location.origin,
      instructions:
        'Check the receipt ID at /api/v1/deletions/{receiptId} with the receipt token in the X-Deletion-Token header. This token can check deletion status only. Keep it private.',
      receiptId: proof.receiptId,
      receiptToken: proof.receiptToken,
    };
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
      ),
      anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'reflection-deletion-receipt.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="notice" aria-label="Deletion receipt">
      <h2>Deletion receipt</h2>
      <p role="status">
        {status?.state === 'complete'
          ? 'Active-store deletion complete.'
          : status
            ? 'Deletion is pending. Access is blocked while it completes.'
            : 'Deletion has not been confirmed. Check the receipt status.'}
      </p>
      {status?.backupExpiresBy && (
        <p>
          Backup retention deadline: {date(status.backupExpiresBy)}. Downloaded copies are
          unchanged.
        </p>
      )}
      <p>
        This receipt can check deletion status after sign-out. It stays only in memory unless you
        download it.
      </p>
      {message && <p role="alert">{message}</p>}
      <div className="actions">
        <button type="button" onClick={() => void check()} disabled={busy}>
          Check deletion status
        </button>
        <button type="button" className="secondary" onClick={download}>
          Download deletion receipt
        </button>
        <button type="button" className="text-button" onClick={onDismiss}>
          Dismiss receipt
        </button>
      </div>
    </section>
  );
}
