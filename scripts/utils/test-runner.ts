/**
 * Runs tests in the target repo and parses results.
 * Extracts individual test failures with names, messages, stacks.
 */

import { spawnSync } from "child_process";
import type { TestRunResult, TestFailure } from "../agents/types.js";

export function runTests(cmd: string, cwd: string): TestRunResult {
  const start = Date.now();
  const result = spawnSync(cmd, {
    shell: true,
    cwd,
    encoding: "utf-8",
    timeout: 120_000, // 2 min max
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? 1;
  const passed = exitCode === 0;

  return {
    passed,
    exitCode,
    stdout,
    stderr,
    failures: parseFailures(stdout + "\n" + stderr),
    duration: Date.now() - start,
  };
}

/**
 * Parses Jest / Vitest / Mocha style failure output into structured failures.
 */
function parseFailures(output: string): TestFailure[] {
  const failures: TestFailure[] = [];

  // Jest/Vitest: ● Test Suite Name › test name
  const jestPattern = /●\s+(.+?)\n\n([\s\S]+?)(?=\n\n●|\n\nTest Suites:|$)/g;
  let m: RegExpExecArray | null;

  while ((m = jestPattern.exec(output)) !== null) {
    const testName = m[1].trim();
    const body = m[2];

    // Extract message (first line before stack)
    const lines = body.split("\n");
    const messageLine = lines.find((l) => l.trim() && !l.trim().startsWith("at ")) ?? lines[0];
    const stackLines = lines.filter((l) => l.trim().startsWith("at ")).slice(0, 5);

    failures.push({
      testName,
      message: messageLine?.trim() ?? "",
      stack: stackLines.join("\n"),
    });
  }

  // Fallback: look for FAIL lines if Jest pattern didn't match
  if (failures.length === 0) {
    const failLines = output
      .split("\n")
      .filter((l) => /FAIL|Error:|AssertionError|TypeError|expect\(/.test(l))
      .slice(0, 10);

    if (failLines.length > 0) {
      failures.push({
        testName: "Test Suite",
        message: failLines.join("\n"),
      });
    }
  }

  return failures;
}

/** Verify tests are RED (failing) — TDD gate */
export function assertTestsRed(result: TestRunResult, context: string): void {
  if (result.passed) {
    console.warn(
      `[TDD Gate] WARNING: ${context} tests passed immediately. ` +
      "They may not be testing new behavior. Proceeding but flagging this."
    );
  } else {
    console.log(`[TDD Gate] ✅ ${context} tests are RED (${result.failures.length} failures). Good.`);
  }
}

/** Verify tests are GREEN (passing) — TDD gate */
export function assertTestsGreen(result: TestRunResult): boolean {
  if (result.passed) {
    console.log("[TDD Gate] ✅ Tests are GREEN.");
    return true;
  }
  console.log(`[TDD Gate] ❌ Tests still RED (${result.failures.length} failures).`);
  return false;
}
