/**
 * Builds structured handoff context for each agent phase.
 * Prevents context contamination by scoping what each agent sees.
 *
 * Pattern from fe-monorepo/scripts/ai/build_agent_contexts.mjs
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { Plan, FileChange, TestRunResult } from "../agents/types.js";

const MAX_FILE_CHARS = 8_000;
const MAX_SNIPPET_FILES = 6;

function readFileSafe(path: string, maxChars = MAX_FILE_CHARS): string {
  try {
    const content = readFileSync(path, "utf-8");
    return content.length > maxChars ? content.slice(0, maxChars) + "\n...[truncated]" : content;
  } catch {
    return "[file not readable]";
  }
}

/** Phase 1 — Planner sees: issue + repo structure + existing tests */
export function buildPlannerContext(params: {
  issueTitle: string;
  issueBody: string;
  repoFiles: string;
  existingTests: string;
  language: string;
}): string {
  return `## Issue to Implement

**Title:** ${params.issueTitle}

**Body:**
${params.issueBody}

---

## Repository File Tree
\`\`\`
${params.repoFiles}
\`\`\`

---

## Existing Test Patterns (for reference)
${params.existingTests}

---

## Language / Stack
${params.language}`;
}

/** Phase 2 — Test Writer sees: plan + repo structure + existing test patterns */
export function buildTestWriterContext(params: {
  issueTitle: string;
  plan: Plan;
  repoFiles: string;
  existingTests: string;
  language: string;
  repoRoot: string;
}): string {
  // Read source files referenced in the plan for type/interface awareness
  const snippets = params.plan.filesToModify
    .slice(0, MAX_SNIPPET_FILES)
    .map((f) => {
      const fullPath = join(params.repoRoot, f);
      if (!existsSync(fullPath)) return null;
      return `### ${f}\n\`\`\`${params.language}\n${readFileSafe(fullPath)}\n\`\`\``;
    })
    .filter(Boolean)
    .join("\n\n");

  return `## Implementation Plan

**Summary:** ${params.plan.summary}

**Files to create:** ${params.plan.filesToCreate.join(", ") || "none"}
**Files to modify:** ${params.plan.filesToModify.join(", ") || "none"}

**Test strategy:** ${params.plan.testStrategy}

**Acceptance criteria:**
${params.plan.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

---

## Existing Test Patterns (match these conventions)
${params.existingTests}

---

## Source Files to Test Against
${snippets || "(no existing source files yet — tests will drive the implementation)"}

---

## Repository File Tree
\`\`\`
${params.repoFiles}
\`\`\``;
}

/** Phase 3 — Implementer sees: plan + failing tests + NO previous impl attempts */
export function buildImplementerContext(params: {
  issueTitle: string;
  plan: Plan;
  testFiles: FileChange[];
  repoRoot: string;
  language: string;
}): string {
  const testContent = params.testFiles
    .map((f) => `### ${f.path}\n\`\`\`${params.language}\n${f.content}\n\`\`\``)
    .join("\n\n");

  // Read existing source context for files the plan says to modify
  const sourceContext = params.plan.filesToModify
    .slice(0, MAX_SNIPPET_FILES)
    .map((f) => {
      const fullPath = join(params.repoRoot, f);
      if (!existsSync(fullPath)) return null;
      return `### ${f} (existing)\n\`\`\`${params.language}\n${readFileSafe(fullPath)}\n\`\`\``;
    })
    .filter(Boolean)
    .join("\n\n");

  return `## Implementation Plan

**Summary:** ${params.plan.summary}

**Files to create:** ${params.plan.filesToCreate.join(", ") || "none"}
**Files to modify:** ${params.plan.filesToModify.join(", ") || "none"}

**Acceptance criteria:**
${params.plan.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

---

## Failing Tests to Make Pass
${testContent}

---

## Existing Source Files
${sourceContext || "(none yet — create the files from scratch)"}`;
}

/** Phase 4 — Healer sees: plan + tests + CURRENT impl + failures + previous diff */
export function buildHealerContext(params: {
  plan: Plan;
  testFiles: FileChange[];
  implFiles: FileChange[];
  testResult: TestRunResult;
  previousDiff: string;
  iteration: number;
  language: string;
}): string {
  const testContent = params.testFiles
    .map((f) => `### ${f.path}\n\`\`\`${params.language}\n${f.content}\n\`\`\``)
    .join("\n\n");

  const implContent = params.implFiles
    .map((f) => `### ${f.path}\n\`\`\`${params.language}\n${f.content.slice(0, MAX_FILE_CHARS)}\n\`\`\``)
    .join("\n\n");

  const failures = params.testResult.failures
    .map((f) => `**${f.testName}**\n${f.message}${f.stack ? "\n" + f.stack.slice(0, 500) : ""}`)
    .join("\n\n");

  return `## Fix Loop — Iteration ${params.iteration}

**Plan summary:** ${params.plan.summary}

---

## Test Failures (${params.testResult.failures.length} failures)
${failures || params.testResult.stderr.slice(-2000) || params.testResult.stdout.slice(-2000)}

---

## What Was Tried in Previous Iteration (diff)
\`\`\`diff
${params.previousDiff.slice(0, 3000) || "(first iteration — no previous diff)"}
\`\`\`

---

## Current Implementation Files
${implContent}

---

## Test Files (do NOT modify these)
${testContent}

---

Analyze the failures carefully.
Trace the execution path mentally before writing any code.
Fix ONLY what is needed to pass the failing tests.`;
}

/** Phase 5 — Reviewer sees: plan + final tests + final impl */
export function buildReviewerContext(params: {
  issueTitle: string;
  plan: Plan;
  testFiles: FileChange[];
  implFiles: FileChange[];
  testResult: TestRunResult;
  language: string;
}): string {
  const testContent = params.testFiles
    .map((f) => `### ${f.path}\n\`\`\`${params.language}\n${f.content.slice(0, 3000)}\n\`\`\``)
    .join("\n\n");

  const implContent = params.implFiles
    .map((f) => `### ${f.path}\n\`\`\`${params.language}\n${f.content.slice(0, 3000)}\n\`\`\``)
    .join("\n\n");

  return `## Review Request — ${params.issueTitle}

**Plan summary:** ${params.plan.summary}

**Tests passed:** ${params.testResult.passed}

**Acceptance criteria:**
${params.plan.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

---

## Implementation Files
${implContent}

---

## Test Files
${testContent}`;
}
