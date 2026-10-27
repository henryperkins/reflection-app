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
  if (mode === 'qualified') return factory ? new ReadingGeneration(base, factory(base)) : null;
  return mode === 'synthetic-local' ? new LocalGeneration(base) : null;
}
