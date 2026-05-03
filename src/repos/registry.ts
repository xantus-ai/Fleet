import { dirname, basename, join } from "node:path";
import { config } from "../config.ts";
import { pool } from "../queue/db.ts";

export type RepoConfig = {
  slug: string;
  githubFullName: string;
  defaultBranch: string;
  workdir: string;
  worktreeRoot: string;
  /**
   * Where per-task audit files (plan.md / progress.md / overview.md)
   * live. Outside the worktree so the agent cannot accidentally commit
   * them. Layout: <taskRecordsRoot>/<branch-name>/{plan,progress,overview}.md.
   */
  taskRecordsRoot: string;
};

function deriveSlug(githubFullName: string): string {
  // owner/name -> name (lower)
  const name = githubFullName.split("/").pop() ?? githubFullName;
  return name.toLowerCase();
}

function deriveWorktreeRoot(workdir: string): string {
  return join(dirname(workdir), `${basename(workdir)}-worktrees`);
}

function deriveTaskRecordsRoot(workdir: string): string {
  return join(dirname(workdir), `${basename(workdir)}-fleet`);
}

export async function ensureDefaultRepo(): Promise<RepoConfig | null> {
  if (!config.github.defaultRepo || !config.github.repoPath) return null;

  const slug = deriveSlug(config.github.defaultRepo);
  const worktreeRoot = deriveWorktreeRoot(config.github.repoPath);
  const taskRecordsRoot = deriveTaskRecordsRoot(config.github.repoPath);

  await pool.query(
    `insert into repos (slug, github_full_name, default_branch, workdir, config)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (slug) do update set
       github_full_name = excluded.github_full_name,
       default_branch   = excluded.default_branch,
       workdir          = excluded.workdir,
       config           = excluded.config`,
    [
      slug,
      config.github.defaultRepo,
      config.github.defaultBranch,
      config.github.repoPath,
      JSON.stringify({ worktreeRoot, taskRecordsRoot }),
    ],
  );

  return {
    slug,
    githubFullName: config.github.defaultRepo,
    defaultBranch: config.github.defaultBranch,
    workdir: config.github.repoPath,
    worktreeRoot,
    taskRecordsRoot,
  };
}

export async function getRepo(slug: string): Promise<RepoConfig | null> {
  const { rows } = await pool.query(
    `select slug, github_full_name, default_branch, workdir, config from repos where slug=$1`,
    [slug],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const cfg = (r.config ?? {}) as {
    worktreeRoot?: string;
    taskRecordsRoot?: string;
  };
  return {
    slug: r.slug,
    githubFullName: r.github_full_name,
    defaultBranch: r.default_branch,
    workdir: r.workdir,
    worktreeRoot: cfg.worktreeRoot ?? deriveWorktreeRoot(r.workdir),
    taskRecordsRoot:
      cfg.taskRecordsRoot ?? deriveTaskRecordsRoot(r.workdir),
  };
}

/**
 * Resolve which repo a task should run against. v1: there's only one default.
 * Multi-repo support hooks in here.
 */
export async function resolveRepo(taskRepo: string | null): Promise<RepoConfig> {
  const slug = taskRepo
    ? deriveSlug(taskRepo)
    : config.github.defaultRepo
      ? deriveSlug(config.github.defaultRepo)
      : null;
  if (!slug) {
    throw new Error(
      "no repo configured: set GITHUB_DEFAULT_REPO and REPO_PATH or pre-seed the repos table",
    );
  }
  const repo = await getRepo(slug);
  if (!repo) {
    throw new Error(`repo "${slug}" not in registry; run \`pnpm admin repo add\``);
  }
  return repo;
}
