import { z } from 'zod';

const Report = z.object({
  success: z.literal(true),
  numTotalTests: z.number().int().positive(),
  numPassedTests: z.number().int().positive(),
  numFailedTests: z.literal(0),
  numPendingTests: z.literal(0),
  numTodoTests: z.literal(0),
  testResults: z
    .array(
      z.object({
        status: z.literal('passed'),
        assertionResults: z.array(z.object({ status: z.literal('passed') })).min(1),
      }),
    )
    .min(1),
});

export function requireExecutedTests(value: unknown): { passed: number; files: number } {
  const report = Report.parse(value);
  const assertions = report.testResults.reduce((n, file) => n + file.assertionResults.length, 0);
  if (report.numTotalTests !== report.numPassedTests || assertions !== report.numPassedTests) {
    throw new Error('Test evidence does not account for every required test');
  }
  return { passed: report.numPassedTests, files: report.testResults.length };
}
