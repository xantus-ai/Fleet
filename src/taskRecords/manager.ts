import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RepoConfig } from "../repos/registry.ts";
import type { Task } from "../queue/db.ts";

export type TaskRecords = {
  /** Absolute directory holding plan.md / progress.md / overview.md. */
  dir: string;
  planPath: string;
  progressPath: string;
  overviewPath: string;
};

const PLAN_TEMPLATE = (task: Task, branch: string) =>
  `# Plan — ${task.linearIssueIdentifier ?? task.linearIssueId}

<!--
Fill in BEFORE starting work. Replace the placeholders below.
This file is for the human auditing the run; it is not committed.
-->

**Branch:** \`${branch}\`
**Ticket:** ${task.title}

## Goal

(restate what the ticket is asking for, in your own words)

## Approach

-

## Files likely to change

-
`;

const PROGRESS_TEMPLATE = `# Progress

<!--
Tick items as you complete them. Add new items as you discover them.
This file is for the human auditing the run; it is not committed.
-->

- [ ] Read relevant code
- [ ] Implement the change
- [ ] Run tests
- [ ] Run linter / typecheck
- [ ] Commit
- [ ] Push
`;

const OVERVIEW_TEMPLATE = `# Overview

<!--
Fill in AT THE END. 2–4 sentences in plain language a non-engineer
stakeholder can read. Describes WHAT changed and WHY. This becomes
the "Overview" section of the PR description.

REPLACE THIS COMMENT WITH THE OVERVIEW. The fleet will refuse to
open a PR if this file is left untouched.
-->
`;

/**
 * Compute the records dir for a branch. Slashes in the branch name
 * (e.g. \`agent/eng-123-foo\`) produce nested directories on disk —
 * intentional, keeps namespaces grouped.
 */
export function recordsDir(repo: RepoConfig, branch: string): string {
  return join(repo.taskRecordsRoot, branch);
}

export function recordsFor(repo: RepoConfig, branch: string): TaskRecords {
  const dir = recordsDir(repo, branch);
  return {
    dir,
    planPath: join(dir, "plan.md"),
    progressPath: join(dir, "progress.md"),
    overviewPath: join(dir, "overview.md"),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the records dir and seed it with templates. Idempotent: only
 * writes a template file if it doesn't already exist (a retry of a
 * failed task should preserve any plan/progress the agent had already
 * filled in).
 */
export async function createTaskRecords(args: {
  repo: RepoConfig;
  branch: string;
  task: Task;
}): Promise<TaskRecords> {
  const records = recordsFor(args.repo, args.branch);
  await mkdir(records.dir, { recursive: true });

  await writeIfMissing(records.planPath, PLAN_TEMPLATE(args.task, args.branch));
  await writeIfMissing(records.progressPath, PROGRESS_TEMPLATE);
  await writeIfMissing(records.overviewPath, OVERVIEW_TEMPLATE);

  return records;
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  if (await exists(path)) return;
  await writeFile(path, content, "utf8");
}

/**
 * Heuristic: a markdown file is "untouched template" if every
 * non-blank, non-HTML-comment line is missing or just punctuation/
 * placeholder text. Returns null when the file is missing or
 * effectively empty; otherwise returns the cleaned content.
 */
export async function readOverview(records: TaskRecords): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(records.overviewPath, "utf8");
  } catch {
    return null;
  }
  return extractOverview(raw);
}

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

export function extractOverview(raw: string): string | null {
  const stripped = raw.replace(HTML_COMMENT_RE, "");

  // Drop the leading "# Overview" heading and any blank lines.
  const lines = stripped.split("\n");
  const meaningful: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^#+\s*overview\s*$/i.test(t)) continue;
    meaningful.push(line);
  }

  if (meaningful.length === 0) return null;

  // Reject obvious template-residual lines.
  const text = meaningful.join("\n").trim();
  if (text.length < 20) return null;
  if (/REPLACE THIS COMMENT/i.test(text)) return null;

  return text;
}
