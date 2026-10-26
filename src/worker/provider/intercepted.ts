import type { WritingProvider, WriterOutcome } from '../../contracts/index.ts';
export type InterceptedWriterOptions = { outcome: WriterOutcome; delayMs?: number };
/** Synthetic local adapter only. It never imports a transport or calls fetch. */
export class InterceptedWritingProvider implements WritingProvider {
  private readonly outcome: WriterOutcome;
  private readonly delayMs: number;
  constructor(options: InterceptedWriterOptions) {
    this.outcome = structuredClone(options.outcome);
    this.delayMs = options.delayMs ?? 0;
    if (!Number.isFinite(this.delayMs) || this.delayMs < 0)
      throw new Error('BAD_INPUT: intercepted delay');
  }
  async write(input: Parameters<WritingProvider['write']>[0]): Promise<WriterOutcome> {
    if (input.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (this.delayMs === 0) return structuredClone(this.outcome);
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        input.signal.removeEventListener('abort', cancel);
        if (input.signal.aborted) {
          reject(new DOMException('Cancelled', 'AbortError'));
          return;
        }
        resolve(
          this.delayMs >= input.timeoutMs
            ? { kind: 'uncertain', reason: 'timeout' }
            : structuredClone(this.outcome),
        );
      };
      const cancel = () => {
        clearTimeout(timer);
        input.signal.removeEventListener('abort', cancel);
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      const timer = setTimeout(settle, Math.min(this.delayMs, input.timeoutMs));
      input.signal.addEventListener('abort', cancel, { once: true });
      if (input.signal.aborted) cancel();
    });
  }
}
