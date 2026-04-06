/**
 * run-tdd.ts
 *
 * TDD implementation loop using Claude.
 * Given a GitHub issue, this script:
 *  1. Clones the target repo
 *  2. Asks Claude to write failing tests based on the issue
 *  3. Runs the tests (they should fail)
 *  4. Asks Claude to implement code to pass the tests
 *  5. Runs tests again and iterates until green (or max retries)
 *  6. Pushes the branch
 *
 * Usage:
 *   CROSS_REPO_PAT=... ANTHROPIC_API_KEY=... tsx scripts/run-tdd.ts \
 *     --owner=myorg --repo=myrepo --issue=42 \
 *     --title="Add feature X" --body="..." \
 *     --test-cmd="npm test" --install-cmd="npm install" --language=typescript
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// --- Arg parsing ---
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  })
);

const OWNER = args["owner"] ?? process.env.ISSUE_OWNER;
const REPO = args["repo"] ?? process.env.ISSUE_REPO;
const ISSUE_NUMBER = Number(args["issue"] ?? process.env.ISSUE_NUMBER);
const TITLE = args["title"] ?? process.env.ISSUE_TITLE ?? "";
const BODY = args["body"] ?? process.env.ISSUE_BODY ?? "";
const TEST_CMD = args["test-cmd"] ?? process.env.TEST_COMMAND ?? "npm test";
const INSTALL_CMD = args["install-cmd"] ?? process.env.INSTALL_COMMAND ?? "npm install";
const LANGUAGE = args["language"] ?? process.env.LANGUAGE ?? "typescript";

if (!OWNER || !REPO || !ISSUE_NUMBER) {
  console.error("Missing required: --owner, --repo, --issue");
  process.exit(1);
}

const PAT = process.env.CROSS_REPO_PAT;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!PAT) throw new Error("CROSS_REPO_PAT is required");
if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");

const BRANCH_NAME = `auto-impl/issue-${ISSUE_NUMBER}`;
const MAX_TDD_ITERATIONS = 3;

// --- Setup ---
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function run(cmd: string, cwd: string): { stdout: string; stderr: string; code: number } {
  const result = spawnSync(cmd, { shell: true, cwd, encoding: "utf-8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? 1,
  };
}

// --- Clone repo ---
console.log(`\nCloning ${OWNER}/${REPO}...`);
const tmpDir = mkdtempSync(join(tmpdir(), `orchestrator-${REPO}-`));
const cloneUrl = `https://x-access-token:${PAT}@github.com/${OWNER}/${REPO}.git`;
run(`git clone "${cloneUrl}" .`, tmpDir);
run(`git checkout -b "${BRANCH_NAME}"`, tmpDir);

// Configure git identity
run('git config user.email "orchestrator-bot@github-actions"', tmpDir);
run('git config user.name "Orchestrator Bot"', tmpDir);

// Install dependencies
console.log("Installing dependencies...");
run(INSTALL_CMD, tmpDir);

// Read repo structure for context
function getRepoContext(dir: string): string {
  const result = run("find . -type f -name '*.ts' -o -name '*.js' | grep -v node_modules | grep -v dist | head -30", dir);
  return result.stdout.trim();
}

const repoFiles = getRepoContext(tmpDir);

// Read existing test files to understand patterns
function readExistingTests(dir: string): string {
  const result = run(
    "find . -type f \\( -name '*.test.ts' -o -name '*.spec.ts' -o -name '*.test.js' -o -name '*.spec.js' \\) | grep -v node_modules | head -5",
    dir
  );
  const testFiles = result.stdout.trim().split("\n").filter(Boolean);

  if (testFiles.length === 0) return "No existing test files found.";

  const samples = testFiles.slice(0, 2).map((f) => {
    try {
      const content = readFileSync(join(dir, f), "utf-8");
      return `// ${f}\n${content.slice(0, 800)}`;
    } catch {
      return "";
    }
  });
  return samples.filter(Boolean).join("\n\n---\n\n");
}

const existingTests = readExistingTests(tmpDir);

// --- Claude: Generate tests ---
console.log("\nAsking Claude to write failing tests...");

interface ContentBlock {
  type: string;
  text?: string;
}

async function askClaude(prompt: string): Promise<string> {
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: prompt }],
  });

  return response.content
    .filter((b): b is ContentBlock & { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function extractCodeBlocks(text: string): Array<{ filename: string; content: string }> {
  const blocks: Array<{ filename: string; content: string }> = [];
  // Match ```lang:filename or ```lang filename or just ```lang
  const re = /```(?:\w+)?(?:[:\s]+([^\n]+))?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const filename = m[1]?.trim() ?? null;
    const content = m[2];
    if (filename && content) {
      blocks.push({ filename, content });
    }
  }
  return blocks;
}

const systemPrompt = `You are an expert ${LANGUAGE} developer using TDD.
When asked to write tests, write them in the style of the existing test files in the repo.
When asked to write implementation, make it minimal and correct.
Always respond with code blocks using the format: \`\`\`${LANGUAGE} path/to/file.ts\n...\n\`\`\`
The filename MUST be included after the language specifier (e.g. \`\`\`typescript src/feature.test.ts).`;

const testPrompt = `${systemPrompt}

Repository: ${OWNER}/${REPO}
Files in repo:
${repoFiles}

Existing test patterns:
${existingTests}

GitHub Issue #${ISSUE_NUMBER}: ${TITLE}
${BODY}

Write FAILING tests that describe the expected behavior for this issue.
The tests should fail because the implementation doesn't exist yet.
Place tests in appropriate test files following the repo's conventions.
Write only the test file(s). Do not implement the feature yet.`;

const testResponse = await askClaude(testPrompt);
console.log("\nClaude test response preview:", testResponse.slice(0, 200));

const testFiles = extractCodeBlocks(testResponse);
if (testFiles.length === 0) {
  // Fallback: try to find a filename in the text and extract all code
  console.warn("Could not extract named code blocks. Attempting fallback...");
  const codeMatch = testResponse.match(/```[\w]*\n([\s\S]*?)```/);
  if (codeMatch) {
    const ext = LANGUAGE === "typescript" ? "ts" : "js";
    testFiles.push({
      filename: `src/__tests__/issue-${ISSUE_NUMBER}.test.${ext}`,
      content: codeMatch[1],
    });
  }
}

// Write test files
for (const { filename, content } of testFiles) {
  const fullPath = join(tmpDir, filename);
  const dir = fullPath.split("/").slice(0, -1).join("/");
  run(`mkdir -p "${dir}"`, tmpDir);
  writeFileSync(fullPath, content, "utf-8");
  console.log(`  Wrote test: ${filename}`);
}

// Run tests - they should FAIL
console.log("\nRunning tests (expecting failures)...");
const failResult = run(TEST_CMD, tmpDir);
console.log("Test output:", failResult.stdout.slice(-500), failResult.stderr.slice(-200));

if (failResult.code === 0) {
  console.log("Tests passed immediately — tests may not be testing new behavior. Proceeding anyway.");
}

// --- TDD Loop: implement until tests pass ---
let testsPassed = false;
let lastTestOutput = failResult.stdout + failResult.stderr;

for (let i = 0; i < MAX_TDD_ITERATIONS; i++) {
  console.log(`\n--- TDD Iteration ${i + 1}/${MAX_TDD_ITERATIONS} ---`);

  // Read current source files for context
  const sourceContext = run(
    "find . -type f \\( -name '*.ts' -o -name '*.js' \\) | grep -v node_modules | grep -v dist | grep -v test | grep -v spec | head -20",
    tmpDir
  ).stdout.trim().split("\n").filter(Boolean).slice(0, 5).map((f) => {
    try {
      const content = readFileSync(join(tmpDir, f), "utf-8");
      return `// ${f}\n${content.slice(0, 600)}`;
    } catch {
      return "";
    }
  }).filter(Boolean).join("\n\n---\n\n");

  const testFileContents = testFiles.map(({ filename, content }) =>
    `// ${filename}\n${content}`
  ).join("\n\n---\n\n");

  const implPrompt = `${systemPrompt}

Repository: ${OWNER}/${REPO}
GitHub Issue #${ISSUE_NUMBER}: ${TITLE}
${BODY}

Test files that need to pass:
${testFileContents}

Current source files:
${sourceContext || "No source files yet"}

Test run output (currently failing):
${lastTestOutput.slice(-1500)}

Implement the minimum code needed to make these tests pass.
Write only implementation files (not test files).
Use the format: \`\`\`${LANGUAGE} path/to/file.ts`;

  const implResponse = await askClaude(implPrompt);
  console.log("Claude impl response preview:", implResponse.slice(0, 200));

  const implFiles = extractCodeBlocks(implResponse);
  if (implFiles.length === 0) {
    console.warn("No implementation files extracted, skipping iteration.");
    continue;
  }

  for (const { filename, content } of implFiles) {
    const fullPath = join(tmpDir, filename);
    const dir = fullPath.split("/").slice(0, -1).join("/");
    run(`mkdir -p "${dir}"`, tmpDir);
    writeFileSync(fullPath, content, "utf-8");
    console.log(`  Wrote impl: ${filename}`);
  }

  // Run tests again
  console.log("Running tests...");
  const testResult = run(TEST_CMD, tmpDir);
  lastTestOutput = testResult.stdout + testResult.stderr;
  console.log("Test output:", lastTestOutput.slice(-500));

  if (testResult.code === 0) {
    console.log("✅ Tests passed!");
    testsPassed = true;
    break;
  } else {
    console.log(`❌ Tests still failing (iteration ${i + 1})`);
  }
}

if (!testsPassed) {
  console.warn(`\nTests did not pass after ${MAX_TDD_ITERATIONS} iterations. Pushing anyway for human review.`);
}

// --- Commit and push ---
run("git add -A", tmpDir);
const commitMsg = `feat: auto-implement issue #${ISSUE_NUMBER} via TDD\n\nCloses #${ISSUE_NUMBER}\n\nGenerated by github-orchestrator using Claude claude-opus-4-6`;
run(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, tmpDir);

console.log("\nPushing branch...");
run(`git push origin "${BRANCH_NAME}"`, tmpDir);

// Output branch name for PR creation step
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import("fs");
  appendFileSync(process.env.GITHUB_OUTPUT, `branch=${BRANCH_NAME}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `tests_passed=${testsPassed}\n`);
} else {
  console.log(`\nBranch: ${BRANCH_NAME}`);
  console.log(`Tests passed: ${testsPassed}`);
}

console.log("\nDone!");
