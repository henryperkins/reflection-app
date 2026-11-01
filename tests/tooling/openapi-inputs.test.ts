import { expect, test } from 'vitest';
import YAML from 'yaml';
import { generateSchemas } from '../../checks/generate-openapi.ts';

test('OpenAPI revisit request schemas permit omitted stance while response schemas require it', () => {
  const document = YAML.parse(generateSchemas()['docs/architecture/openapi.yaml']!);
  const schemas = document.components.schemas;
  const createSchema =
    document.paths['/revisits'].post.requestBody.content['application/json'].schema;
  const createName = createSchema.$ref.split('/').at(-1);
  expect(schemas[createName].required).toEqual(['editionId', 'note']);
  expect(schemas.RevisitUpdate.required).toEqual(['note']);
  expect(schemas[createName].properties.stance.default).toBe('unspecified');
  expect(schemas.RevisitUpdate.properties.stance.default).toBe('unspecified');
  expect(schemas.Revisit.required).toContain('stance');
  expect(schemas.RevisitPage.properties.items.items.required).toContain('stance');
});
