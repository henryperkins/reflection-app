import { providerReceipt } from '../fixtures/provider.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WritingProvider, WriterOutcome } from '../../src/contracts/index.ts';
import { InterceptedWritingProvider } from '../../src/worker/provider/intercepted.ts';
const input = (signal = new AbortController().signal): Parameters<WritingProvider['write']>[0] => ({
  dispatchId: '00000000-0000-4000-8000-000000000001',
  model: 'gpt-6.1-terra',
  payload: new TextEncoder().encode('{"synthetic":"test-only"}'),
  timeoutMs: 18000,
  maxOutputTokens: 1600,
  store: false,
  reasoning: 'none',
  signal,
});
afterEach(() => vi.useRealTimers());
describe('intercepted writer with outbound network denied by test setup', () => {
  it.each<WriterOutcome>([
    {
      kind: 'candidate',
      candidate: { synthetic: 'test-only' },
      receipt: providerReceipt({
        responseId: null,
        returnedModel: 'synthetic-test-only',
        durationMs: 1,
        usage: {
          inputTokens: 20,
          outputTokens: 30,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      }),
    },
    { kind: 'refusal', receipt: null },
    { kind: 'rejected', status: 429, receipt: null },
    { kind: 'rejected', status: 401, receipt: null },
    { kind: 'uncertain', reason: 'timeout', receipt: null },
    { kind: 'uncertain', reason: 'network', receipt: null },
    { kind: 'uncertain', reason: 'lost_response', receipt: null },
  ])('returns configured $kind outcome without fetch', async (outcome) =>
    expect(await new InterceptedWritingProvider({ outcome }).write(input())).toEqual(outcome),
  );
  it('never returns an outcome for an already cancelled call', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      new InterceptedWritingProvider({ outcome: { kind: 'refusal', receipt: null } }).write(
        input(abort.signal),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('cancels a delayed response immediately', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const promise = new InterceptedWritingProvider({
      outcome: { kind: 'refusal', receipt: null },
      delayMs: 1000,
    }).write(input(abort.signal));
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('returns uncertainty at the fixed timeout and removes timers', async () => {
    vi.useFakeTimers();
    const promise = new InterceptedWritingProvider({
      outcome: { kind: 'refusal', receipt: null },
      delayMs: 20000,
    }).write(input());
    await vi.advanceTimersByTimeAsync(18000);
    expect(await promise).toEqual({ kind: 'uncertain', reason: 'timeout', receipt: null });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('returns a delayed configured outcome when it arrives within the timeout', async () => {
    vi.useFakeTimers();
    const promise = new InterceptedWritingProvider({
      outcome: { kind: 'rejected', status: 503, receipt: null },
      delayMs: 500,
    }).write(input());
    await vi.advanceTimersByTimeAsync(500);
    expect(await promise).toEqual({ kind: 'rejected', status: 503, receipt: null });
    expect(vi.getTimerCount()).toBe(0);
  });
});
