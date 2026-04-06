/**
 * Healer Agent — Phase 4 (Self-healing loop, max 3 iterations)
 * Failures + Previous Diff → Fixed Implementation
 *
 * Context: plan + current impl + test failures + previous diff
 * The previous diff prevents re-trying the exact same fix.
 */

import Anthropic from "@anthropic-ai/sdk";
import { calcCost } from "../utils/logger.js";
import { buildHealerContext } from "../utils/context-builder.js";
import type { Plan, FileChange, HealResult, TestRunResult, AgentCall } from "./types.js";

const MODEL = "claude-opus-4-6";

const SYSTEM = `You are a debugging expert fixing failing tests.

Your process:
1. Read the test failures carefully — understand EXACTLY what is failing and why
2. Read the previous diff — understand what was already tried and why it didn't work
3. Read the current implementation — understand the current state
4. Identify the root cause, not just symptoms
5. Apply the minimal fix that addresses the root cause

Rules:
- Do NOT modify test files
- Only output files that need to change
- If the previous approach was wrong, take a completely different approach
- If a type/interface is wrong, fix it at the source

For each file to fix:
\`\`\`typescript path/to/file.ts
// fixed content
\`\`\``;

function extractFileBlocks(text: string): FileChange[] {
  const blocks: FileChange[] = [];
  const re = /```(?:typescript|javascript|tsx|jsx|ts|js)(?:[:\s]+)([^\n]+\.[^\n]+)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[1].trim();
    if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(path)) continue; // never touch test files
    blocks.push({ path, content: m[2] });
  }
  return blocks;
}

function extractConfidence(text: string): HealResult["confidence"] {
  const lower = text.toLowerCase();
  if (lower.includes("confident") || lower.includes("root cause identified")) return "high";
  if (lower.includes("likely") || lower.includes("probably")) return "medium";
  return "low";
}

export async function runHealer(
  client: Anthropic,
  plan: Plan,
  testFiles: FileChange[],
  implFiles: FileChange[],
  testResult: TestRunResult,
  previousDiff: string,
  iteration: number,
  language: string
): Promise<{ result: HealResult; call: AgentCall }> {
  const context = buildHealerContext({
    plan,
    testFiles,
    implFiles,
    testResult,
    previousDiff,
    iteration,
    language,
  });

  const start = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Fix the failing tests. This is iteration ${iteration}.\n\n${context}`,
      },
    ],
  });

  const durationMs = Date.now() - start;
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("Healer returned no text");

  const files = extractFileBlocks(textBlock.text);
  const confidence = extractConfidence(textBlock.text);

  const call: AgentCall = {
    agent: "healer",
    phase: `self-healing-iter-${iteration}`,
    inputTokens,
    outputTokens,
    costUsd: calcCost(MODEL, inputTokens, outputTokens),
    durationMs,
    success: files.length > 0,
  };

  return {
    result: { files, reasoning: textBlock.text.slice(0, 300), confidence },
    call,
  };
}
