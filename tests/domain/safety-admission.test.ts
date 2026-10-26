import { expect, test } from 'vitest';
import { inputAdmission } from '../../src/domain/tarot/safety.ts';
test.each([
  'How can I communicate more patiently with Sue?',
  'What could I reflect on about my treatment of others?',
])('ordinary reflective question is admitted: %s', (question) => {
  expect(inputAdmission(question, 'en')).toBeNull();
});
