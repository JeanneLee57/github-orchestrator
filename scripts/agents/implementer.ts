/**
 * Implementer Agent — Phase 3
 * Plan + Failing Tests → Minimal Implementation (GREEN phase of TDD)
 *
 * Context: plan + test files (the spec) + existing source files
 * Does NOT see: previous healing attempts, reviewer feedback
 */

import Anthropic from "@anthropic-ai/sdk";
import { calcCost } from "../utils/logger.js";
import { buildImplementerContext } from "../utils/context-builder.js";
import type { AgentInput, Plan, FileChange, ImplResult, AgentCall } from "./types.js";

const MODEL = "claude-opus-4-6";

function buildSystem(language: string): string {
  return `You are an expert ${language} developer implementing code using TDD.

Rules:
1. Write ONLY the minimum code needed to make the failing tests pass
2. Do NOT modify the test files
3. Follow the existing code style and patterns in the repo
4. Implement exactly what the tests assert — no more, no less
5. If a test imports from a path that doesn't exist yet, create that file

For each implementation file, respond with:
\`\`\`${language} path/to/file.ts
// implementation
\`\`\`

Before writing code:
1. Read each test carefully
2. Identify exactly what functions/classes/modules are being imported and tested
3. Trace the happy path and failure path mentally
4. Only then write the implementation`;
}

function extractFileBlocks(text: string, language: string): FileChange[] {
  const blocks: FileChange[] = [];

  // Match implementation files (not test files)
  const re = new RegExp(
    `\`\`\`(?:${language}|typescript|javascript|tsx|jsx)(?:[:\\s]+)([^\\n]+\\.(?:ts|tsx|js|jsx))\\n([\\s\\S]*?)\`\`\``,
    "g"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[1].trim();
    // Skip test files — implementer should not modify those
    if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(path)) continue;
    blocks.push({ path, content: m[2] });
  }

  return blocks;
}

export async function runImplementer(
  client: Anthropic,
  input: AgentInput,
  plan: Plan,
  testFiles: FileChange[],
  repoRoot: string
): Promise<{ result: ImplResult; call: AgentCall }> {
  const context = buildImplementerContext({
    issueTitle: input.issueTitle,
    plan,
    testFiles,
    repoRoot,
    language: input.language,
  });

  const start = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    system: buildSystem(input.language),
    messages: [
      {
        role: "user",
        content: `Implement the minimum code to make these tests pass.\n\n${context}`,
      },
    ],
  });

  const durationMs = Date.now() - start;
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("Implementer returned no text");

  const files = extractFileBlocks(textBlock.text, input.language);
  if (files.length === 0) throw new Error("Implementer produced no implementation files");

  const call: AgentCall = {
    agent: "implementer",
    phase: "tdd-green-initial",
    inputTokens,
    outputTokens,
    costUsd: calcCost(MODEL, inputTokens, outputTokens),
    durationMs,
    success: true,
  };

  return {
    result: { files, reasoning: textBlock.text.slice(0, 300) },
    call,
  };
}
