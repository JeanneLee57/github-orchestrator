export interface AgentInput {
  issueTitle: string;
  issueBody: string;
  issueNumber: number;
  owner: string;
  repo: string;
  language: string;
  repoFiles: string;       // file tree of target repo
  existingTests: string;   // sample test files for pattern reference
}

export interface Plan {
  summary: string;
  filesToCreate: string[];
  filesToModify: string[];
  testStrategy: string;
  acceptanceCriteria: string[];
  risks: string[];
}

export interface TestWriteResult {
  files: FileChange[];
  reasoning: string;
}

export interface ImplResult {
  files: FileChange[];
  reasoning: string;
}

export interface HealResult {
  files: FileChange[];
  reasoning: string;
  confidence: "high" | "medium" | "low";
}

export interface ReviewResult {
  approved: boolean;
  issues: string[];
  suggestions: string[];
  summary: string;
}

export interface FileChange {
  path: string;
  content: string;
}

export interface TestRunResult {
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  failures: TestFailure[];
  duration: number;
}

export interface TestFailure {
  testName: string;
  message: string;
  stack?: string;
}

export interface AgentCall {
  agent: string;
  phase: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  success: boolean;
}

export interface OrchestratorSummary {
  issueNumber: number;
  owner: string;
  repo: string;
  branch: string;
  testsPassed: boolean;
  totalCostUsd: number;
  totalDurationMs: number;
  iterations: number;
  agentCalls: AgentCall[];
  phases: PhaseLog[];
}

export interface PhaseLog {
  phase: string;
  status: "success" | "failed" | "skipped";
  details: string;
  durationMs: number;
}
