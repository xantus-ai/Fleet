import { logEvent, type Task } from "../queue/db.ts";
import { markDone, markFailed, markRunning } from "../queue/claim.ts";
import type { LinearAdapter } from "../linear/adapter.ts";

/**
 * Executes one claimed task. In Weekend 1 this is a stub that logs what
 * it *would* do; Weekend 2 swaps the body for the worktree + Claude
 * Agent SDK loop.
 */
export async function runTask(
  task: Task,
  linear: LinearAdapter,
): Promise<void> {
  await markRunning(task.id);
  await linear.notifyStarted(task);
  await logEvent(task.id, "agent_message", {
    text: `[stub] would run task ${task.id} for issue ${task.linearIssueIdentifier ?? task.linearIssueId}`,
  });
  console.log(
    `[worker] stub-running task ${task.id} (${task.linearIssueIdentifier ?? task.linearIssueId}): ${task.title}`,
  );

  try {
    // Weekend 2: worktree create → agent.run() → gh pr create → markPrOpen → notifyPrOpened
    await markDone(task.id);
    await linear.notifyDone(task);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markFailed(task.id, msg);
    await linear.notifyFailed(task, msg).catch((e) =>
      console.error("[worker] notifyFailed errored", e),
    );
    throw err;
  }
}
