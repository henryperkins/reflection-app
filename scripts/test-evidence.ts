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

export function requireBrowserTests(value: unknown): { passed: number; files: number } {
  const report = z
    .object({
      stats: z.object({
        expected: z.number().int().positive(),
        unexpected: z.literal(0),
        skipped: z.literal(0),
        flaky: z.literal(0),
      }),
      errors: z.array(z.unknown()).length(0),
      suites: z.array(z.unknown()).min(1),
    })
    .parse(value);
  const spec = z.object({
    ok: z.literal(true),
    tests: z
      .array(
        z.object({
          expectedStatus: z.literal('passed'),
          status: z.literal('expected'),
          results: z.array(z.object({ status: z.literal('passed') })).length(1),
        }),
      )
      .min(1),
  });
  const files = new Set<string>();
  let passed = 0;
  const visit = (value: unknown) => {
    const suite = z
      .object({
        file: z.string().optional(),
        specs: z.array(spec).default([]),
        suites: z.array(z.unknown()).default([]),
      })
      .parse(value);
    if (suite.specs.length) {
      files.add(suite.file ?? 'nested');
      passed += suite.specs.reduce((n, item) => n + item.tests.length, 0);
    }
    for (const child of suite.suites) visit(child);
  };
  for (const suite of report.suites) visit(suite);
  if (passed !== report.stats.expected)
    throw new Error('Browser evidence does not account for every required test');
  return { passed, files: files.size };
}
