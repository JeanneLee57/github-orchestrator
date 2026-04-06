/**
 * fetch-issues.ts
 *
 * Polls target repos for issues with the trigger label.
 * Outputs a JSON array of issues to trigger TDD implementation for.
 * Used by poll-issues.yml workflow.
 */

import { Octokit } from "@octokit/rest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface RepoConfig {
  owner: string;
  repo: string;
  testCommand: string;
  installCommand: string;
  language: string;
}

interface Config {
  repos: RepoConfig[];
  triggerLabel: string;
  wipLabel: string;
  doneLabel: string;
}

interface IssueTrigger {
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  testCommand: string;
  installCommand: string;
  language: string;
}

const token = process.env.CROSS_REPO_PAT;
if (!token) throw new Error("CROSS_REPO_PAT environment variable is required");

const octokit = new Octokit({ auth: token });

const config: Config = JSON.parse(
  readFileSync(join(__dirname, "../configs/target-repos.json"), "utf-8")
);

async function fetchIssuesToImplement(): Promise<IssueTrigger[]> {
  const triggers: IssueTrigger[] = [];

  for (const repoConfig of config.repos) {
    const { owner, repo } = repoConfig;
    console.log(`Checking ${owner}/${repo} for issues with label "${config.triggerLabel}"...`);

    const { data: issues } = await octokit.issues.listForRepo({
      owner,
      repo,
      labels: config.triggerLabel,
      state: "open",
      per_page: 20,
    });

    for (const issue of issues) {
      // Skip if already WIP or done
      const labelNames = issue.labels.map((l) =>
        typeof l === "string" ? l : l.name ?? ""
      );
      if (
        labelNames.includes(config.wipLabel) ||
        labelNames.includes(config.doneLabel)
      ) {
        console.log(`  Issue #${issue.number} already in progress or done, skipping.`);
        continue;
      }

      // Mark as WIP
      await octokit.issues.addLabels({
        owner,
        repo,
        issue_number: issue.number,
        labels: [config.wipLabel],
      });

      triggers.push({
        owner,
        repo,
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        testCommand: repoConfig.testCommand,
        installCommand: repoConfig.installCommand,
        language: repoConfig.language,
      });

      console.log(`  Queued issue #${issue.number}: ${issue.title}`);
    }
  }

  return triggers;
}

const issues = await fetchIssuesToImplement();

// Output for GitHub Actions: write to GITHUB_OUTPUT or stdout
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import("fs");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `issues=${JSON.stringify(issues)}\n`
  );
} else {
  console.log("\nIssues to implement:");
  console.log(JSON.stringify(issues, null, 2));
}
