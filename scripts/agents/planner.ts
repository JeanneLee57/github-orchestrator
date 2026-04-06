/**
 * Planner Agent — Phase 1
 * Issue → Structured Implementation Plan
 *
 * Keeps context clean: only sees issue + repo structure.
 * Does NOT see previous implementation attempts.
 */

import Anthropic from "@anthropic-ai/sdk";
import { calcCost } from "../utils/logger.js";
import { buildPlannerContext } from "../utils/context-builder.js";
import type { AgentInput, Plan, AgentCall } from "./types.js";

const MODEL = "claude-opus-4-6";

const SYSTEM = `You are a senior software architect.
Your job is to analyze a GitHub issue and produce a precise, actionable implementation plan.
Focus on:
- Exact files to create and modify
- Clear acceptance criteria (testable, specific)
- Test strategy (what to unit-test, what to integration-test)
- Potential risks or ambiguities

Respond with a JSON object matching this exact schema:
{
  "summary": "one-sentence description of what will be implemented",
  "filesToCreate": ["path/to/new/file.ts"],
  "filesToModify": ["path/to/existing/file.ts"],
  "testStrategy": "description of test approach",
  "acceptanceCriteria": ["criterion 1", "criterion 2"],
  "risks": ["potential risk or ambiguity"]
}`;

export async function runPlanner(
  client: Anthropic,
  input: AgentInput
): Promise<{ plan: Plan; call: AgentCall }> {
  const context = buildPlannerContext({
    issueTitle: input.issueTitle,
    issueBody: input.issueBody,
    repoFiles: input.repoFiles,
    existingTests: input.existingTests,
    language: input.language,
  });

  const start = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Analyze this issue and produce an implementation plan.\n\n${context}`,
      },
    ],
  });

  const durationMs = Date.now() - start;
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Planner returned no text content");
  }

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = textBlock.text.match(/```(?:json)?\s*([\s\S]*?)```/) ??
    textBlock.text.match(/(\{[\s\S]*\})/);

  if (!jsonMatch) throw new Error(`Planner response has no JSON:\n${textBlock.text}`);

  let plan: Plan;
  try {
    plan = JSON.parse(jsonMatch[1]) as Plan;
  } catch (e) {
    throw new Error(`Planner JSON parse error: ${e}\n\nRaw: ${jsonMatch[1]}`);
  }

  const call: AgentCall = {
    agent: "planner",
    phase: "plan-generation",
    inputTokens,
    outputTokens,
    costUsd: calcCost(MODEL, inputTokens, outputTokens),
    durationMs,
    success: true,
  };

  return { plan, call };
}
