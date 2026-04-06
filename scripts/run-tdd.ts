/**
 * run-tdd.ts — Main Orchestrator
 *
 * Multi-agent TDD pipeline:
 *   Phase 1: Planner     — Issue → Structured Plan
 *   Phase 2: TestWriter  — Plan  → Failing Tests (RED)
 *   Phase 3: Implementer — Plan + Tests → Initial Implementation
 *   Phase 4: Healer      — Failures + Diff → Self-healing loop (max 3x)
 *   Phase 5: Reviewer    — Final verification
 *
 * Each agent gets scoped context only — no cross-contamination.
 */

import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync } from "fs";
import { join } from "path";

import { Logger } from "./utils/logger.js";
import {
  cloneRepo, createBranch, install, applyFiles,
  getDiff, diffSinceLastCommit, checkpoint, commitAndPush,
  getRepoFileTree, getExistingTestSamples,
} from "./utils/git.js";
import { runTests, assertTestsRed, assertTestsGreen } from "./utils/test-runner.js";
import { runPlanner } from "./agents/planner.js";
import { runTestWriter } from "./agents/test-writer.js";
import { runImplementer } from "./agents/implementer.js";
import { runHealer } from "./agents/healer.js";
import { runReviewer } from "./agents/reviewer.js";
import type { AgentInput, FileChange } from "./agents/types.js";

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_HEAL_ITERATIONS = 3;
const BUDGET_LIMIT_USD = parseFloat(process.env.AI_BUDGET_LIMIT_USD ?? "5.00");

const OWNER        = process.env.ISSUE_OWNER        ?? "";
const REPO         = process.env.ISSUE_REPO         ?? "";
const ISSUE_NUMBER = parseInt(process.env.ISSUE_NUMBER ?? "0");
const TITLE        = process.env.ISSUE_TITLE        ?? "";
const BODY         = process.env.ISSUE_BODY         ?? "";
const TEST_CMD     = process.env.TEST_COMMAND       ?? "npm test";
const INSTALL_CMD  = process.env.INSTALL_COMMAND    ?? "npm install";
const LANGUAGE     = process.env.LANGUAGE           ?? "typescript";

if (!OWNER || !REPO || !ISSUE_NUMBER) {
  console.error("Missing required env: ISSUE_OWNER, ISSUE_REPO, ISSUE_NUMBER");
  process.exit(1);
}

const PAT = process.env.CROSS_REPO_PAT;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!PAT)           throw new Error("CROSS_REPO_PAT is required");
if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY is required");

const BRANCH = `auto-impl/issue-${ISSUE_NUMBER}`;
const LOG_PATH = join(process.cwd(), "logs", `issue-${ISSUE_NUMBER}.log`);
const SUMMARY_PATH = join(process.cwd(), "logs", `issue-${ISSUE_NUMBER}-summary.json`);

// ── Setup ─────────────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
const logger = new Logger(LOG_PATH);

// ── Phase helpers ─────────────────────────────────────────────────────────────

function checkBudget(): void {
  const spent = logger.totalCost();
  if (spent >= BUDGET_LIMIT_USD) {
    throw new Error(`Budget exceeded: $${spent.toFixed(4)} >= $${BUDGET_LIMIT_USD}`);
  }
  console.log(`[Budget] $${spent.toFixed(4)} / $${BUDGET_LIMIT_USD}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\nOrchestrator starting — ${OWNER}/${REPO}#${ISSUE_NUMBER}`);
console.log(`Branch: ${BRANCH}`);
console.log(`Budget limit: $${BUDGET_LIMIT_USD}\n`);

// Clone repo
let repoRoot: string;
{
  const end = logger.startPhase("setup");
  const t = Date.now();
  repoRoot = cloneRepo(OWNER, REPO, PAT);
  createBranch(repoRoot, BRANCH);
  install(repoRoot, INSTALL_CMD);
  logger.endPhase("setup", t, "success", `cloned to ${repoRoot}`);
}

const repoFiles = getRepoFileTree(repoRoot);
const existingTests = getExistingTestSamples(repoRoot, LANGUAGE);

const agentInput: AgentInput = {
  issueTitle: TITLE,
  issueBody: BODY,
  issueNumber: ISSUE_NUMBER,
  owner: OWNER,
  repo: REPO,
  language: LANGUAGE,
  repoFiles,
  existingTests,
};

// ── Phase 1: Plan ─────────────────────────────────────────────────────────────

const planPhaseStart = Date.now();
logger.startPhase("Phase 1: Planning");
const { plan, call: planCall } = await runPlanner(client, agentInput);
logger.recordAgentCall(planCall);
checkBudget();
logger.endPhase("planning", planPhaseStart, "success", plan.summary);

console.log("\nPlan:");
console.log("  Summary:", plan.summary);
console.log("  Create:", plan.filesToCreate);
console.log("  Modify:", plan.filesToModify);
console.log("  Criteria:", plan.acceptanceCriteria);

// ── Phase 2: Write Failing Tests (RED) ───────────────────────────────────────

const testPhaseStart = Date.now();
logger.startPhase("Phase 2: Test Writing (RED)");
const { result: testWriteResult, call: testWriteCall } = await runTestWriter(
  client, agentInput, plan, repoRoot
);
logger.recordAgentCall(testWriteCall);
checkBudget();

applyFiles(repoRoot, testWriteResult.files);
checkpoint(repoRoot, `test: write failing tests for issue #${ISSUE_NUMBER}`);

// TDD Gate: verify tests are RED
console.log("\n[TDD Gate] Running tests — expecting RED...");
const redResult = runTests(TEST_CMD, repoRoot);
assertTestsRed(redResult, "initial");
logger.endPhase("test-writing", testPhaseStart, "success",
  `${testWriteResult.files.length} test files written, ${redResult.failures.length} failures confirmed`);

// ── Phase 3: Initial Implementation (GREEN attempt) ──────────────────────────

const implPhaseStart = Date.now();
logger.startPhase("Phase 3: Implementation (GREEN attempt)");
const { result: implResult, call: implCall } = await runImplementer(
  client, agentInput, plan, testWriteResult.files, repoRoot
);
logger.recordAgentCall(implCall);
checkBudget();

let currentImplFiles: FileChange[] = implResult.files;
applyFiles(repoRoot, currentImplFiles);
checkpoint(repoRoot, `feat: initial implementation for issue #${ISSUE_NUMBER}`);

console.log("\n[TDD Gate] Running tests — attempting GREEN...");
let currentTestResult = runTests(TEST_CMD, repoRoot);
let testsPassed = assertTestsGreen(currentTestResult);
logger.endPhase("implementation", implPhaseStart,
  testsPassed ? "success" : "failed",
  testsPassed ? "Tests GREEN" : `${currentTestResult.failures.length} failures remain`);

// ── Phase 4: Self-healing Loop ────────────────────────────────────────────────

let healIterations = 0;

if (!testsPassed) {
  logger.startPhase("Phase 4: Self-healing Loop");

  for (let i = 1; i <= MAX_HEAL_ITERATIONS && !testsPassed; i++) {
    healIterations = i;
    const healStart = Date.now();
    console.log(`\n--- Heal iteration ${i}/${MAX_HEAL_ITERATIONS} ---`);
    checkBudget();

    // Get diff of what the previous iteration tried — healer uses this to avoid repeating
    const previousDiff = diffSinceLastCommit(repoRoot);
    console.log(`Previous diff: ${previousDiff.split("\n").length} lines`);

    const { result: healResult, call: healCall } = await runHealer(
      client, plan, testWriteResult.files, currentImplFiles,
      currentTestResult, previousDiff, i, LANGUAGE
    );
    logger.recordAgentCall(healCall);

    if (healResult.files.length === 0) {
      console.warn("Healer produced no files — skipping iteration");
      logger.endPhase(`heal-iter-${i}`, healStart, "failed", "no files produced");
      continue;
    }

    // Apply fixes and checkpoint so next iteration can diff against this one
    currentImplFiles = mergeFiles(currentImplFiles, healResult.files);
    applyFiles(repoRoot, healResult.files);
    checkpoint(repoRoot, `fix: heal iteration ${i} for issue #${ISSUE_NUMBER} (confidence: ${healResult.confidence})`);

    console.log(`\n[TDD Gate] Running tests after heal iteration ${i}...`);
    currentTestResult = runTests(TEST_CMD, repoRoot);
    testsPassed = assertTestsGreen(currentTestResult);

    logger.endPhase(`heal-iter-${i}`, healStart,
      testsPassed ? "success" : "failed",
      testsPassed ? "Tests GREEN" : `${currentTestResult.failures.length} failures remain`);

    if (testsPassed) break;
  }
}

// ── Phase 5: Reviewer ─────────────────────────────────────────────────────────

const reviewStart = Date.now();
logger.startPhase("Phase 5: Review");
checkBudget();

const { result: reviewResult, call: reviewCall } = await runReviewer(
  client, TITLE, plan, testWriteResult.files, currentImplFiles,
  currentTestResult, LANGUAGE
);
logger.recordAgentCall(reviewCall);

console.log(`\nReview: ${reviewResult.approved ? "APPROVED" : "NEEDS WORK"}`);
if (reviewResult.issues.length > 0) {
  console.log("Issues:", reviewResult.issues);
}
if (reviewResult.suggestions.length > 0) {
  console.log("Suggestions:", reviewResult.suggestions);
}

logger.endPhase("review", reviewStart, "success", reviewResult.summary.slice(0, 100));

// ── Commit & Push ─────────────────────────────────────────────────────────────

console.log("\nPushing branch...");
commitAndPush(repoRoot, BRANCH, ISSUE_NUMBER);

// ── Summary ───────────────────────────────────────────────────────────────────

const summary = logger.buildSummary(
  ISSUE_NUMBER, OWNER, REPO, BRANCH, testsPassed, healIterations
);
logger.printSummary(summary);
logger.writeSummaryFile(summary, SUMMARY_PATH);
logger.writeGitHubStepSummary(summary);

// Output for create-pr step
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import("fs");
  appendFileSync(process.env.GITHUB_OUTPUT, `branch=${BRANCH}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `tests_passed=${testsPassed}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `review_approved=${reviewResult.approved}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `total_cost=${summary.totalCostUsd.toFixed(4)}\n`);
} else {
  console.log(`\nbranch: ${BRANCH}`);
  console.log(`tests_passed: ${testsPassed}`);
  console.log(`review_approved: ${reviewResult.approved}`);
  console.log(`total_cost: $${summary.totalCostUsd.toFixed(4)}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Merge healer file patches into current impl files (upsert by path) */
function mergeFiles(current: FileChange[], patches: FileChange[]): FileChange[] {
  const map = new Map(current.map((f) => [f.path, f]));
  for (const patch of patches) {
    map.set(patch.path, patch);
  }
  return Array.from(map.values());
}
