import { pool } from "./db.ts";

export type DependencyEdge = {
  taskId: string;
  blockerTaskId: string;
};

export type BlockerContext = {
  identifier: string | null;
  title: string;
  body: string | null;
  prUrl: string | null;
  overviewText: string | null;
};

/**
 * Record blocker → blocked task edges so claimNext can gate dependent
 * tasks on their blockers' completion. Idempotent: re-recording the
 * same edge is a no-op via the table's primary key.
 */
export async function recordDependencies(edges: DependencyEdge[]): Promise<void> {
  if (edges.length === 0) return;
  const values: string[] = [];
  const params: string[] = [];
  edges.forEach((edge, i) => {
    const a = i * 2 + 1;
    const b = i * 2 + 2;
    values.push(`($${a}, $${b})`);
    params.push(edge.taskId, edge.blockerTaskId);
  });
  await pool.query(
    `insert into task_dependencies (task_id, blocker_task_id)
     values ${values.join(", ")}
     on conflict do nothing`,
    params,
  );
}

/**
 * Returns merged-blocker context for a task, ordered by when the
 * dependency edge was recorded (oldest first — matches a reader's
 * catch-up order). Only includes blockers in status='done'; in-flight
 * or failed blockers contribute nothing because the dependent task
 * shouldn't be running yet anyway (claimNext gate).
 */
export async function getBlockerContext(
  taskId: string,
): Promise<BlockerContext[]> {
  const { rows } = await pool.query<{
    linear_issue_identifier: string | null;
    title: string;
    body: string | null;
    pr_url: string | null;
    overview_text: string | null;
  }>(
    `select b.linear_issue_identifier,
            b.title,
            b.body,
            b.pr_url,
            b.overview_text
       from task_dependencies d
       join tasks b on b.id = d.blocker_task_id
      where d.task_id = $1
        and b.status = 'done'
      order by d.created_at`,
    [taskId],
  );
  return rows.map((r) => ({
    identifier: r.linear_issue_identifier,
    title: r.title,
    body: r.body,
    prUrl: r.pr_url,
    overviewText: r.overview_text,
  }));
}
