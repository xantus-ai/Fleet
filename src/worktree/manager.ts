import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RepoConfig } from "../repos/registry.ts";

const execFileP = promisify(execFile);

export type Worktree = {
  dir: string;
  branch: string;
};

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "")
    || "task";
}

export function buildBranchName(args: {
  identifier: string | null;
  taskId: string;
  title: string;
}): string {
  const head = args.identifier?.toLowerCase() ?? args.taskId.slice(0, 8);
  return `agent/${head}-${slugify(args.title)}`;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates an isolated worktree for a task: fresh fetch from origin,
 * a new branch off the repo's default branch, and a working tree in
 * `<repo>-worktrees/<task-id>`.
 *
 * Idempotent on partial failures: removes any prior worktree at the
 * target path before creating a new one.
 */
export async function createWorktree(args: {
  repo: RepoConfig;
  taskId: string;
  branch: string;
}): Promise<Worktree> {
  const { repo, taskId, branch } = args;

  if (!(await exists(repo.workdir))) {
    throw new Error(
      `repo workdir does not exist: ${repo.workdir} (clone ${repo.githubFullName} there first)`,
    );
  }

  await mkdir(repo.worktreeRoot, { recursive: true });
  const dir = join(repo.worktreeRoot, taskId);

  // Reset any leftover state from a previous attempt at this path.
  if (await exists(dir)) {
    await git(repo.workdir, "worktree", "remove", "--force", dir).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }

  await git(repo.workdir, "fetch", "origin", repo.defaultBranch);

  // If the branch already exists locally (rerun of same task), drop it.
  const localBranches = await git(repo.workdir, "branch", "--list", branch);
  if (localBranches) {
    await git(repo.workdir, "branch", "-D", branch).catch(() => {});
  }

  await git(
    repo.workdir,
    "worktree",
    "add",
    "-b",
    branch,
    dir,
    `origin/${repo.defaultBranch}`,
  );

  return { dir, branch };
}

export async function removeWorktree(repo: RepoConfig, dir: string): Promise<void> {
  await git(repo.workdir, "worktree", "remove", "--force", dir).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}

/**
 * Did the agent push the branch to origin?
 */
export async function branchPushed(repo: RepoConfig, branch: string): Promise<boolean> {
  const ref = await git(repo.workdir, "ls-remote", "--heads", "origin", branch);
  return ref.length > 0;
}

/**
 * Did the agent make any commits beyond the base?
 */
export async function hasNewCommits(
  repo: RepoConfig,
  worktreeDir: string,
): Promise<boolean> {
  const count = await git(
    worktreeDir,
    "rev-list",
    "--count",
    `origin/${repo.defaultBranch}..HEAD`,
  );
  return Number(count) > 0;
}
