import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoConfig } from "../repos/registry.ts";
import type { Task } from "../queue/db.ts";

const execFileP = promisify(execFile);

function buildPrBody(task: Task): string {
  const ref = task.linearIssueIdentifier ?? task.linearIssueId;
  return [
    `Implements ${ref}.`,
    "",
    task.body?.trim() ? `> ${task.body.trim().split("\n").join("\n> ")}` : "",
    "",
    "---",
    "",
    `_Opened by the fleet on behalf of Linear ticket \`${ref}\` (task \`${task.id}\`)._`,
  ]
    .filter((s) => s !== undefined)
    .join("\n");
}

function buildPrTitle(task: Task): string {
  if (task.linearIssueIdentifier) {
    return `${task.linearIssueIdentifier}: ${task.title}`;
  }
  return task.title;
}

/**
 * Opens the PR via `gh`. Caller must ensure the branch is already pushed.
 * Returns the PR URL on success.
 */
export async function createPullRequest(args: {
  repo: RepoConfig;
  task: Task;
  branch: string;
}): Promise<string> {
  const { repo, task, branch } = args;
  const title = buildPrTitle(task);
  const body = buildPrBody(task);

  const { stdout } = await execFileP(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      repo.githubFullName,
      "--base",
      repo.defaultBranch,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ],
    { cwd: repo.workdir, maxBuffer: 4 * 1024 * 1024 },
  );

  // gh prints the PR URL on the last non-empty line.
  const url = stdout
    .split("\n")
    .map((s) => s.trim())
    .reverse()
    .find((s) => s.startsWith("https://github.com/"));
  if (!url) {
    throw new Error(`gh pr create produced no URL. stdout: ${stdout}`);
  }
  return url;
}

/**
 * If the agent already opened a PR (older flow), find it and return URL.
 */
export async function findOpenPrForBranch(
  repo: RepoConfig,
  branch: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repo.githubFullName,
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "url",
      ],
      { cwd: repo.workdir, maxBuffer: 1 * 1024 * 1024 },
    );
    const arr = JSON.parse(stdout) as Array<{ url: string }>;
    return arr[0]?.url ?? null;
  } catch {
    return null;
  }
}
