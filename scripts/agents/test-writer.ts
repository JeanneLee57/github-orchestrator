/**
 * Test Writer Agent — Phase 2
 * Plan → Failing Tests (RED phase of TDD)
 *
 * Context: plan + repo patterns + existing test conventions
 * Does NOT see: implementation, previous attempts
 */

import Anthropic from "@anthropic-ai/sdk";
import { calcCost } from "../utils/logger.js";
import { buildTestWriterContext } from "../utils/context-builder.js";
import type { AgentInput, Plan, FileChange, TestWriteResult, AgentCall } from "./types.js";

const MODEL = "claude-opus-4-6";

function buildSystem(language: string): string {
  return `You are a TDD specialist writing ${language} tests.

Rules:
1. Write tests that FAIL because the implementation does not exist yet (RED phase)
2. Follow the exact conventions of existing test files in the repo
3. Tests must be specific and tied directly to the acceptance criteria
4. Cover happy path, edge cases, and error conditions
5. Do NOT write implementation code — tests only

For each test file, respond with a fenced code block:
\`\`\`${language} path/to/file.test.${language === "typescript" ? "ts" : "js"}
// test content
\`\`\`

Think step-by-step about what behavior needs to be tested before writing.`;
}

function extractFileBlocks(text: string, language: string): FileChange[] {
  const ext = language === "typescript" ? "ts" : "js";
  const blocks: FileChange[] = [];

  // Match ```lang path/to/file or ```lang:path/to/file
  const re = new RegExp(
    `\`\`\`(?:${language}|typescript|javascript|tsx|jsx)(?:[:\\s]+)([^\\n]+\\.(?:test|spec)\\.(?:ts|tsx|js|jsx))\\n([\\s\\S]*?)\`\`\``,
    "g"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ path: m[1].trim(), content: m[2] });
  }

  // Fallback: any fenced block with a test-like filename in the header line
  if (blocks.length === 0) {
    const fallback = /```[\w]*\s+([^\n]*\.(?:test|spec)\.[^\n]+)\n([\s\S]*?)```/g;
    while ((m = fallback.exec(text)) !== null) {
      blocks.push({ path: m[1].trim(), content: m[2] });
    }
  }

  // Last resort: unnamed block → auto-name
  if (blocks.length === 0) {
    const any = /```[\w]*\n([\s\S]*?)```/g;
    let idx = 0;
    while ((m = any.exec(text)) !== null) {
      blocks.push({
        path: `src/__tests__/auto-${idx++}.test.${ext}`,
        content: m[1],
      });
    }
  }

  return blocks;
}

export async function runTestWriter(
  client: Anthropic,
  input: AgentInput,
  plan: Plan,
  repoRoot: string
): Promise<{ result: TestWriteResult; call: AgentCall }> {
  const context = buildTestWriterContext({
    issueTitle: input.issueTitle,
    plan,
    repoFiles: input.repoFiles,
    existingTests: input.existingTests,
    language: input.language,
    repoRoot,
  });

  const start = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    // thinking: { type: "adaptive" }, // Temporarily disabled for debugging
    system: buildSystem(input.language),
    messages: [
      {
        role: "user",
        content: `Write failing tests for this implementation plan.\n\n${context}`,
      },
    ],
  });

  const durationMs = Date.now() - start;
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    console.error("Response content:", JSON.stringify(response.content, null, 2));
    throw new Error("Test writer returned no text");
  }

  const files = extractFileBlocks(textBlock.text, input.language);
  if (files.length === 0) throw new Error("Test writer produced no test files");

  const call: AgentCall = {
    agent: "test-writer",
    phase: "tdd-red",
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
