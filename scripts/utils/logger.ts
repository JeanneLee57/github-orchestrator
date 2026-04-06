/**
 * Observability: tracks cost, tokens, timing per agent call and phase.
 * Writes a structured summary JSON for GitHub Actions Step Summary.
 */

import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { AgentCall, PhaseLog, OrchestratorSummary } from "../agents/types.js";

// Pricing per 1M tokens (USD)
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6":   { input: 5.0,  output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0,  output: 15.0 },
  "claude-haiku-4-5":  { input: 1.0,  output:  5.0 },
};

const DEFAULT_PRICING = { input: 5.0, output: 25.0 };

export function calcCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const p = PRICING[model] ?? DEFAULT_PRICING;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export class Logger {
  private agentCalls: AgentCall[] = [];
  private phases: PhaseLog[] = [];
  private startTime = Date.now();
  private logPath: string | null;

  constructor(logPath?: string) {
    this.logPath = logPath ?? null;
    if (this.logPath) {
      const dir = dirname(this.logPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  recordAgentCall(call: AgentCall): void {
    this.agentCalls.push(call);
    const line = `[${new Date().toISOString()}] [${call.agent}/${call.phase}] `
      + `tokens: ${call.inputTokens}in/${call.outputTokens}out | `
      + `cost: $${call.costUsd.toFixed(4)} | `
      + `${call.durationMs}ms | ${call.success ? "OK" : "FAIL"}`;
    console.log(line);
    if (this.logPath) appendFileSync(this.logPath, line + "\n");
  }

  startPhase(phase: string): () => void {
    const t = Date.now();
    console.log(`\n${"=".repeat(60)}`);
    console.log(`PHASE: ${phase}`);
    console.log(`${"=".repeat(60)}`);
    return () => this.endPhase(phase, t);
  }

  endPhase(phase: string, startedAt: number, status: PhaseLog["status"] = "success", details = ""): void {
    const durationMs = Date.now() - startedAt;
    this.phases.push({ phase, status, details, durationMs });
    console.log(`\n[${phase}] ${status.toUpperCase()} (${durationMs}ms)`);
    if (details) console.log(`  ${details}`);
  }

  totalCost(): number {
    return this.agentCalls.reduce((sum, c) => sum + c.costUsd, 0);
  }

  buildSummary(
    issueNumber: number,
    owner: string,
    repo: string,
    branch: string,
    testsPassed: boolean,
    iterations: number
  ): OrchestratorSummary {
    return {
      issueNumber,
      owner,
      repo,
      branch,
      testsPassed,
      totalCostUsd: this.totalCost(),
      totalDurationMs: Date.now() - this.startTime,
      iterations,
      agentCalls: this.agentCalls,
      phases: this.phases,
    };
  }

  writeSummaryFile(summary: OrchestratorSummary, outPath: string): void {
    writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf-8");
    console.log(`\nSummary written to: ${outPath}`);
  }

  printSummary(summary: OrchestratorSummary): void {
    console.log(`\n${"=".repeat(60)}`);
    console.log("ORCHESTRATOR SUMMARY");
    console.log(`${"=".repeat(60)}`);
    console.log(`Issue:        ${summary.owner}/${summary.repo}#${summary.issueNumber}`);
    console.log(`Branch:       ${summary.branch}`);
    console.log(`Tests passed: ${summary.testsPassed}`);
    console.log(`Iterations:   ${summary.iterations}`);
    console.log(`Total cost:   $${summary.totalCostUsd.toFixed(4)}`);
    console.log(`Total time:   ${(summary.totalDurationMs / 1000).toFixed(1)}s`);
    console.log("\nPhases:");
    for (const p of summary.phases) {
      const icon = p.status === "success" ? "✅" : p.status === "failed" ? "❌" : "⏭";
      console.log(`  ${icon} ${p.phase} (${p.durationMs}ms)${p.details ? " - " + p.details : ""}`);
    }
    console.log("\nAgent calls:");
    for (const c of summary.agentCalls) {
      console.log(`  ${c.agent}/${c.phase}: $${c.costUsd.toFixed(4)}`);
    }
  }

  /** Write GitHub Actions step summary markdown */
  writeGitHubStepSummary(summary: OrchestratorSummary): void {
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryFile) return;

    const statusIcon = summary.testsPassed ? "✅" : "⚠️";
    const md = [
      `## ${statusIcon} Orchestrator Summary — Issue #${summary.issueNumber}`,
      "",
      `| | |`,
      `|---|---|`,
      `| **Repo** | \`${summary.owner}/${summary.repo}\` |`,
      `| **Branch** | \`${summary.branch}\` |`,
      `| **Tests passed** | ${summary.testsPassed ? "Yes" : "No"} |`,
      `| **TDD iterations** | ${summary.iterations} |`,
      `| **Total cost** | $${summary.totalCostUsd.toFixed(4)} |`,
      `| **Total time** | ${(summary.totalDurationMs / 1000).toFixed(1)}s |`,
      "",
      "### Phases",
      ...summary.phases.map((p) => {
        const icon = p.status === "success" ? "✅" : p.status === "failed" ? "❌" : "⏭";
        return `- ${icon} **${p.phase}** (${p.durationMs}ms)${p.details ? " — " + p.details : ""}`;
      }),
      "",
      "### Agent Calls",
      "| Agent | Phase | In tokens | Out tokens | Cost |",
      "|---|---|---|---|---|",
      ...summary.agentCalls.map(
        (c) => `| ${c.agent} | ${c.phase} | ${c.inputTokens} | ${c.outputTokens} | $${c.costUsd.toFixed(4)} |`
      ),
    ].join("\n");

    appendFileSync(summaryFile, md + "\n");
  }
}
