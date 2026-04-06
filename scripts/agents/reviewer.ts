/**
 * Reviewer Agent — Phase 5
 * Final verification: checks implementation against plan + acceptance criteria
 *
 * Context: plan + final tests + final implementation
 * Does NOT write code — outputs structured review only.
 */

import Anthropic from "@anthropic-ai/sdk";
import { calcCost } from "../utils/logger.js";
import { buildReviewerContext } from "../utils/context-builder.js";
import type { Plan, FileChange, ReviewResult, TestRunResult, AgentCall } from "./types.js";

const MODEL = "claude-sonnet-4-6"; // Cheaper for review — no code generation needed

const SYSTEM = `You are a senior code reviewer doing a final verification.

Check:
1. Does the implementation satisfy ALL acceptance criteria?
2. Are there obvious bugs or edge cases not covered by tests?
3. Are there any security issues?
4. Is the code maintainable?

Respond with JSON only:
{
  "approved": true/false,
  "issues": ["critical issue 1", "critical issue 2"],
  "suggestions": ["non-blocking suggestion"],
  "summary": "one paragraph review summary"
}`;

export async function runReviewer(
  client: Anthropic,
  issueTitle: string,
  plan: Plan,
  testFiles: FileChange[],
  implFiles: FileChange[],
  testResult: TestRunResult,
  language: string
): Promise<{ result: ReviewResult; call: AgentCall }> {
  const context = buildReviewerContext({
    issueTitle,
    plan,
    testFiles,
    implFiles,
    testResult,
    language,
  });

  const start = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Review this implementation.\n\n${context}`,
      },
    ],
  });

  const durationMs = Date.now() - start;
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("Reviewer returned no text");

  const jsonMatch = textBlock.text.match(/```(?:json)?\s*([\s\S]*?)```/) ??
    textBlock.text.match(/(\{[\s\S]*\})/);

  let result: ReviewResult;
  try {
    result = JSON.parse(jsonMatch?.[1] ?? textBlock.text) as ReviewResult;
  } catch {
    // Fallback if JSON parse fails
    result = {
      approved: testResult.passed,
      issues: [],
      suggestions: [],
      summary: textBlock.text.slice(0, 500),
    };
  }

  const call: AgentCall = {
    agent: "reviewer",
    phase: "final-review",
    inputTokens,
    outputTokens,
    costUsd: calcCost(MODEL, inputTokens, outputTokens),
    durationMs,
    success: true,
  };

  return { result, call };
}
