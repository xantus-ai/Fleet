import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { platform } from "node:os";
import { config } from "../config.ts";
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
 * Recursively find every node_modules directory in a tree, capped at
 * a depth of 4 (handles top-level + a couple of nesting levels for
 * monorepos like cloud's frontend/backend/packages layout). Skips
 * descending *into* node_modules — nested deps are part of the
 * top-level dir we're about to clone.
 */
async function findNodeModulesDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  const SKIP = new Set([".git", "dist", "build", ".next", ".turbo"]);
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules") {
        found.push(join(dir, "node_modules"));
        continue; // don't descend
      }
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      await walk(join(dir, e.name), depth + 1);
    }
  }
  await walk(root, 0);
  return found;
}

/**
 * CoW-clone every node_modules dir from `srcRepo` into `dstWorktree`
 * preserving relative paths. Uses APFS clonefile on macOS and
 * Btrfs/XFS reflink on Linux; both fall back to a regular copy on
 * unsupported filesystems.
 */
async function shareNodeModules(srcRepo: string, dstWorktree: string): Promise<number> {
  const dirs = await findNodeModulesDirs(srcRepo);
  if (dirs.length === 0) return 0;

  const isMac = platform() === "darwin";
  for (const src of dirs) {
    const rel = relative(srcRepo, src);
    const dst = join(dstWorktree, rel);
    await mkdir(dirname(dst), { recursive: true });
    const args = isMac
      ? ["-cR", src, dst]
      : ["-R", "--reflink=auto", src, dst];
    await execFileP("cp", args, { maxBuffer: 4 * 1024 * 1024 });
  }
  return dirs.length;
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

  // CoW-clone node_modules so the agent doesn't need to run a cold
  // `npm install` before it can run typecheck/lint. Failure is
  // non-fatal — agent can install itself if needed.
  if (config.worker.shareNodeModules) {
    try {
      const n = await shareNodeModules(repo.workdir, dir);
      if (n > 0) console.log(`[worktree] cloned ${n} node_modules dir(s) into ${dir}`);
    } catch (err) {
      console.warn(`[worktree] node_modules share failed (continuing): ${err}`);
    }
  }

  // Scope the bot identity to this worktree only. Per-worktree config
  // beats per-repo and global, so the operator's normal identity
  // continues to apply outside the worktree (e.g. when they manually
  // commit on the cloud main checkout).
  if (config.bot.gitName && config.bot.gitEmail) {
    await git(dir, "config", "user.name", config.bot.gitName);
    await git(dir, "config", "user.email", config.bot.gitEmail);
    // The bot has no signing key on this machine. If the operator has
    // commit signing enabled globally, the agent's commits would fail
    // without this. Per-worktree, so it doesn't disable signing
    // anywhere else.
    await git(dir, "config", "commit.gpgsign", "false");
  }

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
