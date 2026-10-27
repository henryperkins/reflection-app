import { digest, type EvaluationRequest } from './provider-evaluation-corpus.ts';
import { canonicalJson } from '../src/domain/json.ts';

/** Source-ID enums differ by draw. A single example schema is not a whole-run contract. */
export function reviewRequestContract(requests: EvaluationRequest[]) {
  const responseSchemasByCase: Record<string, unknown> = {};
  const requestSchemaHashes: Record<string, string> = {};
  for (const request of requests) {
    const wire = JSON.parse(new TextDecoder().decode(request.input.payload));
    if (wire.text?.format?.type !== 'json_schema') throw new Error('Missing request schema');
    const hash = digest(canonicalJson(wire.text));
    if (
      request.caseId in responseSchemasByCase &&
      digest(canonicalJson(responseSchemasByCase[request.caseId])) !== hash
    )
      throw new Error('Schema differs within case');
    responseSchemasByCase[request.caseId] = wire.text;
    requestSchemaHashes[request.id] = hash;
  }
  return { schemaScope: 'fixed-within-case' as const, responseSchemasByCase, requestSchemaHashes };
}
