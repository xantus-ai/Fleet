import { config } from "../config.ts";
import { logEvent, pool, rowToTask, type Task } from "./db.ts";

export type EnqueueInput = {
  linearIssueId: string;
  linearIssueIdentifier: string | null;
  title: string;
  body: string | null;
  repo: string | null;
};

export type EnqueueResult =
  | { kind: "enqueued"; task: Task }
  | { kind: "duplicate"; task: Task };

/**
 * Idempotent. If a task already exists for the Linear issue, returns it
 * unchanged so webhook redeliveries don't double-run.
 */
export async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
  const { rows } = await pool.query(
    `insert into tasks (linear_issue_id, linear_issue_identifier, title, body, repo,
                        budget_tokens_remaining, budget_seconds_remaining)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (linear_issue_id) do nothing
     returning *`,
    [
      input.linearIssueId,
      input.linearIssueIdentifier,
      input.title,
      input.body,
      input.repo,
      config.worker.tokenBudget,
      config.worker.wallclockSeconds,
    ],
  );

  if (rows.length === 1) {
    const task = rowToTask(rows[0]);
    await logEvent(task.id, "status_change", { to: "pending", source: "webhook" });
    return { kind: "enqueued", task };
  }

  const existing = await pool.query(
    `select * from tasks where linear_issue_id = $1`,
    [input.linearIssueId],
  );
  return { kind: "duplicate", task: rowToTask(existing.rows[0]) };
}

/**
 * Atomically claim the next pending task (or recover a stale claim) using
 * SELECT … FOR UPDATE SKIP LOCKED. Returns null if none available.
 *
 * A pending task is only claimable when every blocker recorded in
 * task_dependencies has reached status='done'. Stale-claim recovery
 * ignores the blocker gate — those tasks already started, so their
 * blockers were satisfied at claim time.
 */
export async function claimNext(workerId: string): Promise<Task | null> {
  const { rows } = await pool.query(
    `update tasks
        set status='claimed',
            claimed_by=$1,
            claimed_at=now(),
            heartbeat_at=now(),
            attempt_count=attempt_count+1
      where id = (
        select t.id from tasks t
         where (
                 t.status='pending'
             and not exists (
                   select 1 from task_dependencies d
                     join tasks b on b.id = d.blocker_task_id
                    where d.task_id = t.id
                      and b.status <> 'done'
                 )
               )
            or (t.status in ('claimed','running')
                and t.heartbeat_at < now() - ($2::int || ' seconds')::interval)
         order by t.created_at
         for update skip locked
         limit 1)
      returning *`,
    [workerId, config.worker.staleClaimSeconds],
  );

  if (rows.length === 0) return null;
  const task = rowToTask(rows[0]);
  await logEvent(task.id, "status_change", {
    to: "claimed",
    workerId,
    attempt: task.attemptCount,
  });
  return task;
}

export async function heartbeat(taskId: string, workerId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update tasks
        set heartbeat_at = now()
      where id = $1 and claimed_by = $2
        and status in ('claimed','running')`,
    [taskId, workerId],
  );
  return (rowCount ?? 0) > 0;
}

export async function markRunning(taskId: string): Promise<void> {
  await pool.query(
    `update tasks set status='running' where id = $1 and status='claimed'`,
    [taskId],
  );
  await logEvent(taskId, "status_change", { to: "running" });
}

export async function markPrOpen(
  taskId: string,
  prUrl: string,
  branch: string,
  overviewText: string | null = null,
): Promise<void> {
  await pool.query(
    `update tasks
        set status='pr_open',
            pr_url=$2,
            branch_name=$3,
            overview_text=coalesce($4, overview_text)
      where id=$1`,
    [taskId, prUrl, branch, overviewText],
  );
  await logEvent(taskId, "status_change", { to: "pr_open", prUrl, branch });
}

export async function markDone(taskId: string): Promise<void> {
  await pool.query(`update tasks set status='done' where id=$1`, [taskId]);
  await logEvent(taskId, "status_change", { to: "done" });
}

export async function markFailed(taskId: string, error: string): Promise<void> {
  await pool.query(
    `update tasks set status='failed', error=$2 where id=$1`,
    [taskId, error],
  );
  await logEvent(taskId, "status_change", { to: "failed", error });
}

export async function markCancelled(taskId: string): Promise<void> {
  await pool.query(`update tasks set status='cancelled' where id=$1`, [taskId]);
  await logEvent(taskId, "status_change", { to: "cancelled" });
}
