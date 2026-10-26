import { expect, test } from 'vitest';
import { requireExecutedTests } from '../../scripts/test-evidence.ts';

const success = {
  success: true,
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: [{ status: 'passed', assertionResults: [{ status: 'passed' }] }],
};

test('requires a successful report accounting for every executed test', () => {
  expect(requireExecutedTests(success)).toEqual({ passed: 1, files: 1 });
});
test('skipped runtime tests and empty runtime reports cannot pass the gate', () => {
  expect(() =>
    requireExecutedTests({ ...success, numPassedTests: 0, numPendingTests: 1 }),
  ).toThrow();
  expect(() =>
    requireExecutedTests({ ...success, numTotalTests: 0, numPassedTests: 0, testResults: [] }),
  ).toThrow();
  expect(() => requireExecutedTests({ ...success, numTodoTests: 1 })).toThrow();
  expect(() =>
    requireExecutedTests({
      ...success,
      testResults: [{ status: 'passed', assertionResults: [{ status: 'pending' }] }],
    }),
  ).toThrow();
});
