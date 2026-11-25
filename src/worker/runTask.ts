import { config } from "../config.ts";
import {
  markDone,
  markFailed,
  markPrOpen,
  markRunning,
} from "../queue/claim.ts";
import { recordCost } from "../queue/budget.ts";
import { getBlockerContext } from "../queue/dependencies.ts";
import { buildDiagnostics } from "../queue/diagnostics.ts";
import { logEvent, type Task } from "../queue/db.ts";
import type { LinearAdapter } from "../linear/adapter.ts";
import { runAgent } from "../agent/runner.ts";
import {
  branchPushed,
  buildBranchName,
  createWorktree,
  hasNewCommits,
  removeWorktree,
} from "../worktree/manager.ts";
import { resolveRepo } from "../repos/registry.ts";
import { createPullRequest, findOpenPrForBranch } from "../github/pr.ts";
import { createTaskRecords, readOverview } from "../taskRecords/manager.ts";

class TaskFailure extends Error {
  constructor(
    message: string,
    readonly leaveBranch = false,
  ) {
    super(message);
  }
}

export async function runTask(task: Task, linear: LinearAdapter): Promise<void> {
  await markRunning(task.id);

  const repo = await resolveRepo(task.repo);
  const branch = buildBranchName({
    identifier: task.linearIssueIdentifier,
    taskId: task.id,
    title: task.title,
  });
  await logEvent(task.id, "branch_assigned", { branch, repo: repo.slug });

  await linear.notifyStarted({ ...task, branchName: branch });

  // Wallclock budget — abort the agent if it runs over.
  const wallclockMs = (task.budgetSecondsRemaining ?? config.worker.wallclockSeconds) * 1000;
  const wallclock = new AbortController();
  const wallclockTimer = setTimeout(() => wallclock.abort(), wallclockMs);

  let worktreeDir: string | null = null;
  try {
    const records = await createTaskRecords({ repo, branch, task });
    await logEvent(task.id, "task_records_created", { dir: records.dir });

    const wt = await createWorktree({ repo, taskId: task.id, branch });
    worktreeDir = wt.dir;
    await logEvent(task.id, "worktree_created", { dir: wt.dir, branch });

    const blockers = await getBlockerContext(task.id);
    if (blockers.length > 0) {
      await logEvent(task.id, "blocker_context_loaded", {
        count: blockers.length,
        identifiers: blockers.map((b) => b.identifier),
      });
    }

    const agent = await runAgent({
      task,
      worktreeDir: wt.dir,
      branch,
      records,
      linear,
      signal: wallclock.signal,
      blockers,
    });
    await recordCost(task.id, agent.costUsd);

    if (!agent.ok) {
      throw new TaskFailure(
        agent.reason ?? "agent ended without success",
        true,
      );
    }

    if (!(await hasNewCommits(repo, wt.dir))) {
      throw new TaskFailure("agent produced no commits", true);
    }

    if (!(await branchPushed(repo, branch))) {
      throw new TaskFailure(
        "agent finished but branch was not pushed to origin",
        true,
      );
    }

    const overview = await readOverview(records);
    if (!overview) {
      throw new TaskFailure(
        "agent did not write overview.md (PR annotation is required)",
        true,
      );
    }
    await logEvent(task.id, "overview_captured", {
      length: overview.length,
    });

    let prUrl = await findOpenPrForBranch(repo, branch);
    if (!prUrl) {
      prUrl = await createPullRequest({ repo, task, branch, overview });
    }

    await markPrOpen(task.id, prUrl, branch, overview);
    await linear.notifyPrOpened({ ...task, branchName: branch }, prUrl);
    await markDone(task.id);
    await linear.notifyDone({ ...task, branchName: branch, prUrl });

    if (worktreeDir) {
      await removeWorktree(repo, worktreeDir).catch((e) =>
        console.warn(`[worker] worktree cleanup failed: ${e}`),
      );
      worktreeDir = null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const leaveBranch = err instanceof TaskFailure ? err.leaveBranch : true;
    await markFailed(task.id, msg);

    const diag = await buildDiagnostics(task.id).catch(() => ({
      recentToolCalls: [],
      finalAssistantText: undefined,
    }));
    await linear
      .notifyFailed(
        { ...task, branchName: branch },
        { ...diag, error: msg },
      )
      .catch((e) => console.error("[worker] notifyFailed errored", e));

    // Failure path: leave the worktree behind for inspection unless we
    // know it's safe to remove (e.g., worktree creation itself failed).
    if (!leaveBranch && worktreeDir) {
      await removeWorktree(repo, worktreeDir).catch(() => {});
    }
    throw err;
  } finally {
    clearTimeout(wallclockTimer);
  }
}
