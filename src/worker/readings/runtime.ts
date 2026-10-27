import { ReadingGeneration, type GenerationDependencies } from './generation.ts';
import { LocalGeneration } from './local-generation.ts';
import type { RecordBase } from './base.ts';

/** Supplied by trusted server bootstrap, never by JSON bindings or request input. */
export type GenerationFactory = (base: RecordBase) => GenerationDependencies;
export function generationService(
  base: RecordBase,
  mode: string | undefined,
  factory?: GenerationFactory,
) {
  if (mode === 'qualified' || mode === 'live-local' || mode === 'live-preview') {
    const dependencies = factory?.(base);
    if (
      !dependencies ||
      dependencies.authorization.kind !== (mode === 'qualified' ? 'application' : mode)
    )
      return null;
    return new ReadingGeneration(base, dependencies);
  }
  return mode === 'synthetic-local' ? new LocalGeneration(base) : null;
}
