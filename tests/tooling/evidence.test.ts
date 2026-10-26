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

test('browser evidence requires executed passing cases and rejects skips, expected failures and empty reports', async () => {
  const { requireBrowserTests } = await import('../../scripts/test-evidence.ts');
  const report = {
    stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 },
    errors: [],
    suites: [
      {
        file: 'identity.spec.ts',
        specs: [
          {
            ok: true,
            tests: [
              { expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] },
            ],
          },
        ],
      },
    ],
  };
  expect(requireBrowserTests(report)).toEqual({ passed: 1, files: 1 });
  expect(() => requireBrowserTests({ ...report, suites: [] })).toThrow();
  expect(() =>
    requireBrowserTests({ ...report, stats: { ...report.stats, skipped: 1 } }),
  ).toThrow();
  expect(() => requireBrowserTests({ ...report, errors: [{ message: 'setup failed' }] })).toThrow();
  expect(() =>
    requireBrowserTests({
      ...report,
      suites: [
        {
          specs: [
            {
              ok: true,
              tests: [
                { expectedStatus: 'failed', status: 'expected', results: [{ status: 'failed' }] },
              ],
            },
          ],
        },
      ],
    }),
  ).toThrow();
});
